import { resolve } from 'node:path';
import { defineConfig, type Plugin, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadConfig } from '../core/src/config/load';

const protectDevProxy: Plugin = {
  name: 'protect-dev-proxy',
  configureServer(server) {
    server.middlewares.use('/api', (request, response, next) => {
      const host = request.headers.host;
      let valid = false;
      try {
        const url = new URL(`http://${host ?? ''}`);
        const address = server.httpServer?.address();
        valid = Boolean(host && !/[\s\/@?#\\,]/.test(host) &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
          typeof address === 'object' && address !== null && Number(url.port || 80) === address.port &&
          (!request.headers.origin || request.headers.origin === url.origin) &&
          (['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '') || request.headers.origin === url.origin) &&
          request.headers['sec-fetch-site'] !== 'cross-site');
      } catch {
        valid = false;
      }
      if (!valid) {
        response.writeHead(403).end('Invalid Host or Origin');
        return;
      }
      next();
    });
  },
};

export default defineConfig(async ({ command }): Promise<UserConfig> => {
  let backend = 'http://127.0.0.1:4317';
  if (command === 'serve') {
    const web = await loadConfig().then(({ config }) => config.web)
      .catch(() => { throw new Error('Invalid or unreadable web configuration'); });
    const portOverride = process.env.OMNIAGENT_PORT;
    if (portOverride !== undefined && (!/^\d+$/.test(portOverride) || Number(portOverride) < 1 || Number(portOverride) > 65535)) {
      throw new Error('OMNIAGENT_PORT must be an integer between 1 and 65535');
    }
    const host = web.host === '0.0.0.0' ? '127.0.0.1' : web.host === '::' ? '::1' : web.host;
    backend = `http://${host.includes(':') ? `[${host}]` : host}:${portOverride ?? web.port}`;
  }
  return {
  root: resolve(import.meta.dirname, 'ui'),
  plugins: [protectDevProxy, react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 4318,
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            if (request.headers.origin) proxyRequest.setHeader('origin', backend);
          });
        },
      },
    },
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  };
});
