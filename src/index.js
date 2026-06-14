const { loadEnv } = require("./utils/env");
const { startBot } = require("./bot");
const { startServer } = require("./server");
const { initializeStorage } = require("./storage");
const { configBackend } = require("./config");

async function main() {
  loadEnv();
  const storage = await initializeStorage();
  console.log(`Stockage: ${storage.backend}`);
  console.log(`Configuration: ${configBackend()}`);
  const client = await startBot();
  const { port } = await startServer(client);
  console.log(`Bot connecté en tant que ${client.user.tag}`);
  console.log(`Panel admin: http://localhost:${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
