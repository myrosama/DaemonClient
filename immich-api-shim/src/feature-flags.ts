import type { Env } from './index';
import { json, requireAuth } from './helpers';
import { getCachedConfig } from './cached-config';

export interface PhotosFeatureFlags {
  directBytePath: boolean;
  adaptiveConcurrency: boolean;
  encryptedPreviewV2: boolean;
  mobileResumeV2: boolean;
  byoWorkerFallback: boolean;
}

const DEFAULT_FLAGS: PhotosFeatureFlags = {
  directBytePath: true,
  adaptiveConcurrency: true,
  encryptedPreviewV2: true,
  mobileResumeV2: true,
  byoWorkerFallback: true,
};

export async function getFlagsForUser(env: Env, uid: string, idToken: string): Promise<PhotosFeatureFlags> {
  const stored = await getCachedConfig<Partial<PhotosFeatureFlags>>(env, uid, idToken, 'photosFlags');
  return { ...DEFAULT_FLAGS, ...(stored || {}) };
}

export async function handleFeatureFlags(request: Request, env: Env, path: string): Promise<Response> {
  const session = await requireAuth(request, env);
  if (path === '/api/policy/flags' && request.method === 'GET') {
    const flags = await getFlagsForUser(env, session.uid, session.idToken);
    return json(flags);
  }
  return json({ message: 'Feature flag endpoint not found' }, 404);
}
