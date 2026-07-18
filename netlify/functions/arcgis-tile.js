"use strict";

const WORLD_IMAGERY_TILE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

function resp(code, obj) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  };
}

function intParam(params, name) {
  const raw = params.get(name);
  if (!/^\d+$/.test(raw || "")) return null;
  return Number(raw);
}

function validTile(z, y, x) {
  if (![z, y, x].every(Number.isInteger)) return false;
  if (z < 0 || z > 23) return false;
  const max = Math.pow(2, z) - 1;
  return x >= 0 && x <= max && y >= 0 && y <= max;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "GET") return resp(405, { error: "Method not allowed" });

  const params = event.rawQuery
    ? new URLSearchParams(event.rawQuery)
    : new URLSearchParams(event.queryStringParameters || {});
  const z = intParam(params, "z");
  const y = intParam(params, "y");
  const x = intParam(params, "x");
  if (!validTile(z, y, x)) return resp(400, { error: "Invalid tile coordinates" });

  const url = new URL(`${WORLD_IMAGERY_TILE}/${z}/${y}/${x}`);
  const key = process.env.ARCGIS_API_KEY;
  if (key) url.searchParams.set("token", key);

  try {
    const upstream = await fetch(url.toString());
    if (!upstream.ok) {
      console.error("arcgis-tile upstream error:", upstream.status, upstream.statusText);
      return resp(502, { error: "Map tile unavailable" });
    }
    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const bytes = Buffer.from(await upstream.arrayBuffer());
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400"
      },
      body: bytes.toString("base64")
    };
  } catch (e) {
    console.error("arcgis-tile fetch failed:", e && e.message ? e.message : e);
    return resp(502, { error: "Map tile unavailable" });
  }
};
