import type { Env } from './index';
import { json } from './helpers';

export async function handleServer(_request: Request, _env: Env, path: string): Promise<Response> {
  if (path === '/api/server/config' || path === '/api/server-info/config') return json(serverConfig());
  if (path === '/api/server/features') return json(serverFeatures());
  if (path === '/api/server/about') return json(serverAbout());
  if (path === '/api/server/version') return json({ major: 2, minor: 7, patch: 5 });
  if (path === '/api/server/version-history') return json([]);
  if (path === '/api/server/setup') return json({ isInitialized: true, isOnboarded: true });
  if (path === '/api/server/media-types') return json(mediaTypes());
  if (path === '/api/server/statistics') return json({ photos: 0, videos: 0, usage: 0, usageByUser: [] });
  if (path === '/api/server/storage') return json({ diskAvailable: '∞', diskSize: '∞', diskUse: '0', diskUsagePercentage: 0 });
  if (path === '/api/server/license') return json({});
  if (path === '/api/server/theme') return json({ customCss: '' });
  if (path === '/api/server/onboarding') return json({});
  if (path === '/api/server/ping') return json({ res: 'pong' });
  return json({ message: 'Not found' }, 404);
}

function serverConfig() {
  return {
    loginPageMessage: '',
    trashDays: 30,
    userDeleteDelay: 7,
    isInitialized: true,
    isOnboarded: true,
    externalDomain: 'https://photos.daemonclient.uz',
    maintenanceMode: false,
    publicUsers: false,
    mapDarkStyleUrl: '',
    mapLightStyleUrl: '',
    oauthButtonText: 'Login with OAuth',
  };
}

function serverFeatures() {
  return {
    configFile: false,
    duplicateDetection: false,
    email: false,
    facialRecognition: false,
    importFaces: false,
    map: false,
    oauth: false,
    oauthAutoLaunch: false,
    ocr: false,
    passwordLogin: true,
    reverseGeocoding: false,
    search: true,
    sidecar: false,
    smartSearch: true,
    trash: true,
  };
}

function serverAbout() {
  return {
    version: '1.115.0',
    versionUrl: '',
    licensed: true,
    build: 'daemonclient',
    buildUrl: '',
    buildImage: '',
    buildImageUrl: '',
    repository: 'DaemonClient',
    repositoryUrl: 'https://github.com/myrosama/DaemonClient',
    sourceRef: 'main',
    sourceCommit: '',
    sourceUrl: '',
    nodejs: '',
    ffmpeg: '',
    imagemagick: '',
    libvips: '',
    exiftool: '',
  };
}

function mediaTypes() {
  return {
    image: [
      '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.avif',
      '.tiff', '.tif', '.bmp', '.svg', '.ico', '.raw', '.cr2', '.nef',
      '.arw', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw', '.x3f',
      '.3fr', '.rwl', '.cap', '.iiq', '.erf', '.nrw', '.jxl',
    ],
    sidecar: ['.xmp'],
    video: [
      '.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.3gp',
      '.mpg', '.mpeg', '.wmv', '.flv', '.mts', '.m2ts',
    ],
  };
}
