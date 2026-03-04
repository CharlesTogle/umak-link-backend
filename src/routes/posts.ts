import { FastifyInstance } from 'fastify';
import postsReadRoutes from './posts/read.js';
import postsWriteRoutes from './posts/write.js';
import postsStatusRoutes from './posts/status.js';
import postsImageRoutes from './posts/images.js';

export default async function postsRoutes(server: FastifyInstance) {
  await server.register(postsReadRoutes);
  await server.register(postsWriteRoutes);
  await server.register(postsStatusRoutes);
  await server.register(postsImageRoutes);
}
