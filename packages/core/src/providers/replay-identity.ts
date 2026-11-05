import { createHash } from 'node:crypto';

export function replayEndpointHash(identity: string): string {
  return createHash('sha256').update(identity).digest('hex');
}
