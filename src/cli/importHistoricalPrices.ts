import fetch from "node-fetch";
import { toUNIXTimestamp } from "../utils/date";
import dynamodb from "../utils/dynamodb";
import { iterateOverPlatforms, Coin } from "../utils/coingeckoPlatforms";
import { getCoingeckoLock, setTimer } from "../storeTvlUtils/coingeckoLocks";

async function coingeckoRequest(url: string) {
  await getCoingeckoLock();
  return fetch(url).then((r) => r.json());
}

type PriceRange = [number, number][]
type PriceRangeResponse = Promise<{
  prices: PriceRange;
}>;

const DAY = 24 * 3600;

const toTimestamp = toUNIXTimestamp(Date.now());
const fromTimestamp = toTimestamp - 80 * DAY; // -80 days
const batchWriteStep = 25; // Max items written at once are 25
const startingCoinIndex = 0;

async function storePrices(PK: string, prices:PriceRange) {
  console.log("\t", PK);
  const writeRequests = [];
  for (let i = 0; i < prices.length; i += batchWriteStep) {
    const items = prices.slice(i, i + batchWriteStep).map((price) => ({
      SK: toUNIXTimestamp(price[0]),
      PK,
      price: price[1],
    }));
    const timestamps = items.map(t=>t.SK);
    const nonDuplicatedItems = items.filter((item, index)=>timestamps.slice(0, index).indexOf(item.SK) === -1)
    writeRequests.push(dynamodb.batchWrite(nonDuplicatedItems));
  }
  await Promise.all(writeRequests);
}

async function main() {
  if (toTimestamp - toTimestamp > 90 * DAY) {
    throw new Error(
      "Timestamp difference is higher than 90 days, it needs to be lower in order to get hourly rates"
    );
  }
  setTimer(1500);
  const coins = (await coingeckoRequest(
    "https://api.coingecko.com/api/v3/coins/list"
  )) as Coin[];
  for (
    let coinIndex = startingCoinIndex;
    coinIndex < coins.length;
    coinIndex++
  ) {
    const coin = coins[coinIndex];
    console.log(`Getting data for ${coin.id} at index ${coinIndex}...`);
    try {
      const [coinData, { prices }] = await Promise.all([
        coingeckoRequest(
          `https://api.coingecko.com/api/v3/coins/${coin.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`
        ),
        coingeckoRequest(
          `https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart/range?vs_currency=usd&from=${fromTimestamp}&to=${toTimestamp}`
        ) as PriceRangeResponse,
      ]);
      await iterateOverPlatforms(coinData, coin, async (PK) => storePrices(PK, prices));
      await storePrices(`asset#${coin.id}`, prices);
    } catch (e) {
      console.log(`Error at token ${coinIndex}, retrying...`)
      coinIndex -= 1;
    }
  }
}
main();
