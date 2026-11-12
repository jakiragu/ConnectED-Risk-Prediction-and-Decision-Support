import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/**
 * dynalite (the in-process DynamoDB the store tests use) has no
 * TransactWriteItems. This runs a transaction's items one by one with their
 * conditions and, if one fails, puts every earlier item back as it was, then
 * throws what DynamoDB throws: TransactionCanceledException with a reason per
 * item. Faithful for these single-threaded tests; real atomicity is DynamoDB's
 * (and DynamoDB Local's, which `npm run api` uses).
 */
export function emulateTransactions(ddb) {
  const send = ddb.send.bind(ddb);
  ddb.send = async (command, ...rest) => {
    if (!(command instanceof TransactWriteCommand)) return send(command, ...rest);
    const items = command.input.TransactItems;
    const undo = [];
    for (let i = 0; i < items.length; i++) {
      const [kind, p] = Object.entries(items[i])[0];
      const Key = kind === 'Put' ? { PK: p.Item.PK, SK: p.Item.SK } : p.Key;
      const before = (await send(new GetCommand({ TableName: p.TableName, Key }))).Item;
      try {
        if (kind === 'Put') await send(new PutCommand(p));
        else if (kind === 'Update') await send(new UpdateCommand(p));
        else if (kind === 'Delete') await send(new DeleteCommand(p));
        else if (kind === 'ConditionCheck') checkOnly(p, before);
        else throw new Error(`transactShim: ${kind} is not emulated`);
        undo.push({ TableName: p.TableName, Key, before });
      } catch (e) {
        for (const u of undo.reverse()) {
          if (u.before) await send(new PutCommand({ TableName: u.TableName, Item: u.before }));
          else await send(new DeleteCommand({ TableName: u.TableName, Key: u.Key }));
        }
        const failed = e.name === 'ConditionalCheckFailedException';
        throw Object.assign(new Error('Transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: items.map((_, j) => ({ Code: j === i ? (failed ? 'ConditionalCheckFailed' : e.name) : 'None' })),
        });
      }
    }
    return {};
  };
}

/**
 * A ConditionCheck writes nothing; only the existence checks the repositories use are emulated
 * (e.g. assessmentRepo's termOpen: the term lock must not exist). Anything else is refused loudly.
 */
function checkOnly(p, item) {
  const expr = p.ConditionExpression.trim();
  const holds = expr === 'attribute_not_exists(PK)' ? !item
    : expr === 'attribute_exists(PK)' ? Boolean(item)
    : (() => { throw new Error(`transactShim: ConditionCheck "${expr}" is not emulated`); })();
  if (!holds) throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
}
