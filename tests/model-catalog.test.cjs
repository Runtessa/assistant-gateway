const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readModelCatalog } = require('../lib/modelCatalog');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtessa-models-'));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const adapter = (script) => {
  const filename = path.join(directory, `cli-${Math.random()}.cjs`);
  fs.writeFileSync(filename, script);
  return (options) => {
    assert.deepEqual(options.args, ['app-server']);
    assert.equal(options.userId, 'isolated-user');
    return {
      child: spawn(process.execPath, [filename], { stdio: options.stdio }),
    };
  };
};

test('model discovery waits for initialization, keeps stdin open and reads every page', async () => {
  const spawnCli = adapter(`
    const rl = require('node:readline').createInterface({input:process.stdin});
    let initialized = false;
    rl.on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') {
        setTimeout(() => process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n'), 15);
      } else if (request.method === 'initialized') initialized = true;
      else if (request.method === 'model/list') {
        if (!initialized) process.exit(2);
        const result = request.params.cursor
          ? {data:[{id:'second',model:'model-two',isDefault:true}], nextCursor:null}
          : {data:[{id:'first',model:'model-one'}], nextCursor:'page-two'};
        const response = JSON.stringify({id:request.id,result})+'\\n';
        process.stdout.write(response.slice(0,12));
        setTimeout(() => process.stdout.write(response.slice(12)), 5);
      }
    });
    rl.on('close', () => process.exit(3));
  `);
  assert.deepEqual(await readModelCatalog('isolated-user', spawnCli), [
    { id: 'first', model: 'model-one' },
    { id: 'second', model: 'model-two', isDefault: true },
  ]);
});

test('initialization errors reject instead of inventing a model list', async () => {
  const spawnCli = adapter(`process.stdin.once('data', data => {
    const request = JSON.parse(data.toString());
    console.log(JSON.stringify({id:request.id,error:{message:'unsupported client'}}));
  });`);
  await assert.rejects(
    readModelCatalog('isolated-user', spawnCli),
    /unsupported client/,
  );
});

test('early exit, missing CLI and timeout produce bounded errors', async () => {
  await assert.rejects(
    readModelCatalog('isolated-user', adapter('process.exit(1)')),
    /exited before/,
  );
  await assert.rejects(
    readModelCatalog('isolated-user', () => {
      throw Error('CLI missing');
    }),
    /CLI missing/,
  );
  await assert.rejects(
    readModelCatalog('isolated-user', adapter('process.stdin.resume()'), 40),
    /timed out/,
  );
});
