import { FastifyInstance } from 'fastify';
import postsReadRoutes, { PostsReadRouteOptions } from './posts/read.js';
import postsWriteRoutes, { PostsWriteRouteOptions } from './posts/write.js';
import postsStatusRoutes from './posts/status.js';
import postsImageRoutes from './posts/images.js';

interface PostsRouteOptions {
  readRouteOptions?: PostsReadRouteOptions;
  writeRouteOptions?: PostsWriteRouteOptions;
}

export default async function postsRoutes(
  server: FastifyInstance,
  options: PostsRouteOptions = {}
) {
  await server.register(postsReadRoutes, options.readRouteOptions ?? {});
  await server.register(postsWriteRoutes, options.writeRouteOptions ?? {});
  await server.register(postsStatusRoutes);
  await server.register(postsImageRoutes);
}
