import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

const SESSION_FILES_DIR = process.env.SESSION_FILES_DIR || path.resolve(__dirname, '..', 'DATA');

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'bdr-session-files-api',
        configureServer(server) {
          const sseClients: Set<any> = new Set();
          let watchTimer = null;
          if (fs.existsSync(SESSION_FILES_DIR)) {
            fs.watch(SESSION_FILES_DIR, {recursive: true}, (_eventType, filename) => {
              if (!filename || !filename.toLowerCase().endsWith('.json')) return;
              if (watchTimer) clearTimeout(watchTimer);
              watchTimer = setTimeout(() => {
                const payload = JSON.stringify({changed: filename, at: new Date().toISOString()});
                for (const client of sseClients) {
                  client.write(`data: ${payload}\n\n`);
                }
              }, 300);
            });
          }

          // Lightweight status endpoint - returns just timestamps, no data
          server.middlewares.use('/api/session-files-status', (_req, res) => {
            try {
              if (!fs.existsSync(SESSION_FILES_DIR)) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ available: false, loadedAt: null, files: {} }));
                return;
              }
              const entries = fs.readdirSync(SESSION_FILES_DIR, {withFileTypes: true})
                .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'));
              const files: Record<string, string> = {};
              let latestMtime = 0;
              entries.forEach(entry => {
                const fp = path.join(SESSION_FILES_DIR, entry.name);
                try {
                  const stat = fs.statSync(fp);
                  files[entry.name] = stat.mtime.toISOString();
                  if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
                } catch { /* skip */ }
              });
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-store');
              res.end(JSON.stringify({
                available: entries.length > 0,
                loadedAt: new Date(latestMtime || Date.now()).toISOString(),
                fileCount: entries.length,
                files,
              }));
            } catch (error) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ available: false, loadedAt: null, error: String(error) }));
            }
          });

          server.middlewares.use('/api/session-files-watch', (req, res) => {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            res.write('data: connected\n\n');
            sseClients.add(res);
            req.on('close', () => {
              sseClients.delete(res);
            });
          });

          server.middlewares.use('/api/session-files', (_req, res) => {
            try {
              const entries = fs
                .readdirSync(SESSION_FILES_DIR, {withFileTypes: true})
                .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'));

              const machines: Record<string, unknown> = {};
              const skipped: Array<{file: string; reason: string}> = [];

              for (const entry of entries) {
                const filePath = path.join(SESSION_FILES_DIR, entry.name);
                const machineName = entry.name.replace(/\.json$/i, '');

                try {
                  const content = fs.readFileSync(filePath, 'utf8').trim();
                  if (!content) {
                    skipped.push({file: entry.name, reason: 'empty file'});
                    continue;
                  }

                  const raw = JSON.parse(content);
                  let data: Record<string, unknown> | null = null;
                  if (raw && typeof raw === 'object') {
                    if ('slots' in raw) {
                      data = raw;
                    } else {
                      // Flat format: slots at top level with numeric keys
                      const obj = raw as Record<string, unknown>;
                      const slotKeys = Object.keys(obj).filter(k =>
                        k !== 'saved_at' &&
                        obj[k] && typeof obj[k] === 'object' &&
                        ('serial_number' in (obj[k] as Record<string, unknown>) ||
                         'ring_name' in (obj[k] as Record<string, unknown>) ||
                         'bdr_state' in (obj[k] as Record<string, unknown>))
                      );
                      if (slotKeys.length > 0) {
                        data = { slots: {} };
                        slotKeys.forEach(k => { (data!.slots as Record<string, unknown>)[k] = obj[k]; });
                      }
                    }
                  }
                  if (!data) {
                    skipped.push({file: entry.name, reason: 'missing slots'});
                    continue;
                  }

                  machines[machineName] = data;
                } catch (error) {
                  skipped.push({
                    file: entry.name,
                    reason: error instanceof Error ? error.message : 'read/parse failed',
                  });
                }
              }

              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-store');
              res.end(JSON.stringify({
                sourceDir: SESSION_FILES_DIR,
                loadedAt: new Date().toISOString(),
                machines,
                skipped,
              }));
            } catch (error) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                error: error instanceof Error ? error.message : 'failed to read session files',
                sourceDir: SESSION_FILES_DIR,
              }));
            }
          });
        },
      },
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
