// DynamoDB access. One item per weekend, keyed by the Saturday date:
// { weekendOf: "2026-11-14", sat: { dan: true, ... }, sun: { ... }, result: { sat: "07:20", sun: null, at } }
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const Table = () => process.env.TABLE_NAME;

export async function getWeekend(weekendOf) {
  const { Item } = await doc.send(new GetCommand({ TableName: Table(), Key: { weekendOf } }));
  return Item || null;
}

export async function getWeekends(ids) {
  if (!ids.length) return [];
  const out = await doc.send(new BatchGetCommand({ RequestItems: { [Table()]: { Keys: ids.map((weekendOf) => ({ weekendOf })) } } }));
  return out.Responses?.[Table()] || [];
}

export async function setTick(weekendOf, day, player, value) {
  // Make sure the day's map exists, then set the one player.
  await doc.send(new UpdateCommand({
    TableName: Table(), Key: { weekendOf },
    UpdateExpression: "SET #d = if_not_exists(#d, :empty)",
    ExpressionAttributeNames: { "#d": day }, ExpressionAttributeValues: { ":empty": {} },
  }));
  await doc.send(new UpdateCommand({
    TableName: Table(), Key: { weekendOf },
    UpdateExpression: "SET #d.#p = :v, updatedAt = :t",
    ExpressionAttributeNames: { "#d": day, "#p": player },
    ExpressionAttributeValues: { ":v": value, ":t": new Date().toISOString() },
  }));
}

export async function saveResult(weekendOf, result) {
  await doc.send(new UpdateCommand({
    TableName: Table(), Key: { weekendOf },
    UpdateExpression: "SET #r = :r", ExpressionAttributeNames: { "#r": "result" }, ExpressionAttributeValues: { ":r": result },
  }));
}
