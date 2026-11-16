const url = process.argv[2];

if (url === undefined) {
  console.error("set url as an argument");
  process.exit(1);
}

const response = await fetch(url);

if (!response.ok) {
  console.error("HTTP request failed: ", response.status);
  process.exit(1);
}

const body = await response.arrayBuffer();

console.log("bytes length:", body.byteLength);
