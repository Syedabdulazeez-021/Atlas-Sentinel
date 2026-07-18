/**
 * Atlas Sentinel MCP Server
 * 
 * Main entry point for the MCP server.
 * Uses the @McpApp decorator pattern for clean, NestJS-style architecture.
 * 
 * Transport Configuration:
 * - Development (NODE_ENV=development): STDIO only
 * - Production (NODE_ENV=production): Dual transport (STDIO + HTTP SSE)
 */

// Load .env from an absolute path anchored to this module, NOT process.cwd().
// MCP clients launch the server from their own working directory, so the plain
// `import 'dotenv/config'` (which resolves .env against cwd) silently finds
// nothing and every tool that needs TELEGRAM_BOT_TOKEN fails with a bogus
// "Set TELEGRAM_BOT_TOKEN in .env" error even though .env exists.
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives one level under the project root in both src/ and dist/.
for (const candidate of [
  resolve(__dirname, '..', '.env'),
  resolve(process.cwd(), '.env'),
]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
    break;
  }
}

import { McpApplicationFactory } from '@nitrostack/core';
import { AppModule } from './app.module.js';

// Crash shield: a tool bug or stray rejection must NEVER kill the MCP server.
process.on('uncaughtException', (err) => { console.error('[atlas] uncaughtException (survived):', err); });
process.on('unhandledRejection', (err) => { console.error('[atlas] unhandledRejection (survived):', err); });


/**
 * Bootstrap the application
 */
async function bootstrap() {
  // Create and start the MCP server
  const server = await McpApplicationFactory.create(AppModule);
  await server.start();
}

// Start the application
bootstrap().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
