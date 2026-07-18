"use strict";

const test = require("node:test");
const assert = require("node:assert");

const fn = require("../netlify/functions/arcgis-tile.js");

function ev(query) {
  return { httpMethod: "GET", rawQuery: query };
}

test("arcgis tile proxy appends ARCGIS_API_KEY as token without exposing it in code", async () => {
  const oldKey = process.env.ARCGIS_API_KEY;
  const oldFetch = global.fetch;
  const urls = [];
  process.env.ARCGIS_API_KEY = "test-arcgis-key";
  global.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer
    };
  };

  try {
    const res = await fn.handler(ev("z=20&y=399999&x=299999"));
    assert.equal(res.statusCode, 200);
    assert.equal(res.isBase64Encoded, true);
    assert.match(urls[0], /World_Imagery\/MapServer\/tile\/20\/399999\/299999\?token=test-arcgis-key$/);
  } finally {
    if (oldKey === undefined) delete process.env.ARCGIS_API_KEY;
    else process.env.ARCGIS_API_KEY = oldKey;
    global.fetch = oldFetch;
  }
});

test("arcgis tile proxy rejects invalid coordinates before fetch", async () => {
  const oldFetch = global.fetch;
  global.fetch = async () => { throw new Error("fetch should not run"); };
  try {
    const res = await fn.handler(ev("z=24&y=0&x=0"));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, "Invalid tile coordinates");
  } finally {
    global.fetch = oldFetch;
  }
});
