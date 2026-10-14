const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};

const rawBodies = new WeakMap();
const readBody = (req) => {
  if (rawBodies.has(req)) return rawBodies.get(req);
  const pending = new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        chunks.length = 0;
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
  rawBodies.set(req, pending);
  return pending;
};

const parseBody = async (req) => {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }); }
};

module.exports = {
  json,
  parseBody,
  readBody,
};
