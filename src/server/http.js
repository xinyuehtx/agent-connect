'use strict';

const path = require('path');
const { registerRoutes } = require('./routes');

/**
 * 构造 Fastify 应用（Web UI + API + SSE + /im/handle）。
 * @param {object} deps
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
async function buildHttp(deps) {
  const Fastify = require('fastify');
  const fstatic = require('@fastify/static');

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

  const webRoot = deps.webRoot || path.join(__dirname, '..', '..', 'web');
  await app.register(fstatic, { root: webRoot, prefix: '/' });

  registerRoutes(app, deps);
  await app.ready();
  return app;
}

module.exports = { buildHttp };
