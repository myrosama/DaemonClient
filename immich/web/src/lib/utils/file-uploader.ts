import {
  AssetMediaStatus,
  AssetUploadAction,
  AssetVisibility,
  checkBulkUpload,
  getBaseUrl,
  type AssetMediaResponseDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { tick } from 'svelte';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import { addAssetsToAlbums } from '$lib/services/album.service';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import { uploadRequest } from '$lib/utils';
import { ExecutorQueue } from '$lib/utils/executor-queue';
import { asQueryString } from '$lib/utils/shared-links';
import { handleError } from './handle-error';

export const addDummyItems = () => {
  uploadAssetsStore.addItem({ id: 'asset-0', file: { name: 'asset0.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-0', { state: UploadState.PENDING });
  uploadAssetsStore.addItem({ id: 'asset-1', file: { name: 'asset1.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-1', { state: UploadState.STARTED });
  uploadAssetsStore.updateProgress('asset-1', 75, 100);
  uploadAssetsStore.addItem({ id: 'asset-2', file: { name: 'asset2.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-2', { state: UploadState.ERROR, error: new Error('Internal server error') });
  uploadAssetsStore.addItem({ id: 'asset-3', file: { name: 'asset3.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-3', { state: UploadState.DUPLICATED, assetId: 'asset-2' });
  uploadAssetsStore.addItem({ id: 'asset-4', file: { name: 'asset3.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-4', { state: UploadState.DUPLICATED, assetId: 'asset-2', isTrashed: true });
  uploadAssetsStore.addItem({ id: 'asset-10', file: { name: 'asset3.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-10', { state: UploadState.DONE });
  uploadAssetsStore.track('error');
  uploadAssetsStore.track('success');
  uploadAssetsStore.track('duplicate');
};

// addDummyItems();

export const uploadExecutionQueue = new ExecutorQueue({ concurrency: 1 });

type FilePickerParam = { multiple?: boolean; extensions?: string[] };
type FileUploadParam = { multiple?: boolean; albumId?: string };

export const openFilePicker = async (options: FilePickerParam = {}) => {
  const { multiple = true, extensions } = options;

  return new Promise<File[]>((resolve, reject) => {
    try {
      const fileSelector = document.createElement('input');

      fileSelector.type = 'file';
      fileSelector.multiple = multiple;

      if (extensions) {
        fileSelector.accept = extensions.join(',');
      }

      fileSelector.addEventListener(
        'change',
        (e: Event) => {
          const target = e.target as HTMLInputElement;
          if (!target.files) {
            return;
          }

          const files = Array.from(target.files);
          resolve(files);
        },
        { passive: true },
      );

      fileSelector.click();
    } catch (error) {
      console.log('Error selecting file', error);
      reject(error);
    }
  });
};

export const openFileUploadDialog = async (options: FileUploadParam = {}) => {
  const { albumId, multiple = true } = options;
  const extensions = uploadManager.getExtensions();
  const files = await openFilePicker({
    multiple,
    extensions,
  });

  return fileUploadHandler({ files, albumId });
};

type FileUploadHandlerParams = Omit<FileUploaderParams, 'deviceAssetId' | 'assetFile'> & {
  files: File[];
};

export const fileUploadHandler = async ({
  files,
  albumId,
  isLockedAssets = false,
}: FileUploadHandlerParams): Promise<string[]> => {
  const extensions = uploadManager.getExtensions();
  const promises = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (extensions.some((extension) => name.endsWith(extension))) {
      const deviceAssetId = getDeviceAssetId(file);
      uploadAssetsStore.addItem({ id: deviceAssetId, file, albumId });
      promises.push(
        uploadExecutionQueue.addTask(() => fileUploader({ deviceAssetId, assetFile: file, albumId, isLockedAssets })),
      );
    } else {
      toastManager.warning(get(t)('unsupported_file_type', { values: { file: file.name, type: file.type } }), {
        timeout: 10_000,
      });
    }
  }

  const results = await Promise.all(promises);
  return results.filter((result): result is string => !!result);
};

function getDeviceAssetId(asset: File) {
  return 'web' + '-' + asset.name + '-' + asset.lastModified;
}

function hashFile(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL('$lib/workers/hash-file.ts', import.meta.url), { type: 'module' });

    worker.addEventListener('message', ({ data }: MessageEvent<{ result?: string; error?: string }>) => {
      worker.terminate();

      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve(data.result!);
      }
    });

    worker.addEventListener('error', (event) => {
      worker.terminate();

      reject(new Error(event.message));
    });

    worker.postMessage(file);
  });
}

function extractDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.onloadedmetadata = () => {
        resolve({ width: video.videoWidth, height: video.videoHeight });
        URL.revokeObjectURL(url);
      };
      video.onerror = () => resolve({ width: 0, height: 0 });
      video.src = url;
    } else {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
        URL.revokeObjectURL(url);
      };
      img.onerror = () => resolve({ width: 0, height: 0 });
      img.src = url;
    }
  });
}

async function generateThumbnail(file: File): Promise<Blob | null> {
  try {
    const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|avi|webm|mkv)$/i.test(file.name);
    const isHeic = /\.(heic|heif)$/i.test(file.name) || file.type.includes('heic');

    if (isVideo) {
      return await new Promise<Blob | null>((resolve) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';

        const timeout = setTimeout(() => {
          console.warn('[Thumb] Video frame extraction timed out for', file.name);
          URL.revokeObjectURL(url);
          resolve(null);
        }, 10000);

        const extractFrame = () => {
          clearTimeout(timeout);
          const canvas = document.createElement('canvas');
          let w = video.videoWidth;
          let h = video.videoHeight;
          if (w === 0 || h === 0) { URL.revokeObjectURL(url); resolve(null); return; }
          const scale = Math.min(256 / w, 256 / h, 1);
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((b) => {
            URL.revokeObjectURL(url);
            console.log(`[Thumb] Video frame extracted for ${file.name}: ${b?.size || 0} bytes`);
            resolve(b);
          }, 'image/jpeg', 0.8);
        };

        video.onseeked = extractFrame;
        video.onloadeddata = () => {
          video.currentTime = Math.min(1, video.duration / 2);
        };
        video.onerror = () => {
          clearTimeout(timeout);
          console.warn('[Thumb] Video load error for', file.name);
          URL.revokeObjectURL(url);
          resolve(null);
        };
        video.src = url;
        video.load();
      });
    }

    let sourceBlob: Blob = file;
    if (isHeic) {
      try {
        const module = await import('$lib/utils/heic2any.js');
        const heic2any = module.default || module;
        const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.8 });
        sourceBlob = Array.isArray(converted) ? converted[0] : converted;
      } catch (e) {
        console.warn('[Thumb] HEIC conversion failed, trying raw:', e);
      }
    }

    const bitmap = await createImageBitmap(sourceBlob);
    const scale = Math.min(256 / bitmap.width, 256 / bitmap.height, 1);
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => {
        console.log(`[Thumb] Image thumbnail generated for ${file.name}: ${blob?.size || 0} bytes`);
        resolve(blob);
      }, 'image/jpeg', 0.8);
    });
  } catch (error) {
    console.error('[Thumb] Failed to generate thumbnail:', error);
    return null;
  }
}

type FileUploaderParams = {
  assetFile: File;
  albumId?: string;
  replaceAssetId?: string;
  isLockedAssets?: boolean;
  // TODO rework the asset uploader and remove this
  deviceAssetId: string;
};

// TODO: should probably use the @api SDK
async function fileUploader({
  assetFile,
  deviceAssetId,
  albumId,
  isLockedAssets = false,
}: FileUploaderParams): Promise<string | undefined> {
  const fileCreatedAt = new Date(assetFile.lastModified).toISOString();
  const $t = get(t);
  const wasInitiallyLoggedIn = !!authManager.authenticated;

  uploadAssetsStore.markStarted(deviceAssetId);

  try {
    const formData = new FormData();
    for (const [key, value] of Object.entries({
      fileCreatedAt,
      fileModifiedAt: new Date(assetFile.lastModified).toISOString(),
      isFavorite: 'false',
      assetData: new File([assetFile], assetFile.name),
    })) {
      formData.append(key, value);
    }

    if (isLockedAssets) {
      formData.append('visibility', AssetVisibility.Locked);
    }

    let responseData: { id: string; status: AssetMediaStatus; isTrashed?: boolean } | undefined;
    if (!authManager.isSharedLink) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_hashing') });
      await tick();
      try {
        const checksum = await hashFile(assetFile);

        const {
          results: [checkUploadResult],
        } = await checkBulkUpload({ assetBulkUploadCheckDto: { assets: [{ id: assetFile.name, checksum }] } });
        if (checkUploadResult.action === AssetUploadAction.Reject && checkUploadResult.assetId) {
          responseData = {
            status: AssetMediaStatus.Duplicate,
            id: checkUploadResult.assetId,
            isTrashed: checkUploadResult.isTrashed,
          };
        }
      } catch (error) {
        console.error(`Error calculating sha1 file=${assetFile.name})`, error);
      }
    }

    if (!responseData) {
      const queryParams = asQueryString(authManager.params);

      const { width, height } = await extractDimensions(assetFile);
      formData.append('width', width.toString());
      formData.append('height', height.toString());

      let thumbBlob: Blob | null = null;
      try {
        thumbBlob = await generateThumbnail(assetFile);
      } catch (e) {
        console.error('Thumb generation failed', e);
      }

      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_uploading') });
      
      // --- DaemonClient Drive Upload Interceptor ---
      const { daemonDrive } = await import('./daemonclient-drive');
      try {
          const driveMeta = await daemonDrive.uploadMedia(assetFile, thumbBlob, (loaded, total) => {
              uploadAssetsStore.updateProgress(deviceAssetId, loaded, total);
          });
          
          // Rebuild formData for metadata-only submission
          const metaForm = new FormData();
          metaForm.append('clientUpload', 'true');
          metaForm.append('telegramChunks', JSON.stringify(driveMeta.telegramChunks));
          metaForm.append('telegramOriginalId', driveMeta.telegramOriginalId || '');
          if (driveMeta.telegramThumbId) metaForm.append('telegramThumbId', driveMeta.telegramThumbId);
          metaForm.append('encryptionMode', driveMeta.encryptionMode);
          
          // Add essential metadata
          metaForm.append('fileCreatedAt', fileCreatedAt);
          metaForm.append('fileModifiedAt', new Date(assetFile.lastModified).toISOString());
          metaForm.append('isFavorite', 'false');
          metaForm.append('width', width.toString());
          metaForm.append('height', height.toString());
          metaForm.append('fileName', assetFile.name);
          metaForm.append('fileSize', assetFile.size.toString());
          metaForm.append('mimeType', assetFile.type);
          if (isLockedAssets) metaForm.append('visibility', AssetVisibility.Locked);
          
          try {
            const checksum = await hashFile(assetFile);
            metaForm.append('checksum', checksum);
          } catch (e) {
            console.warn('Checksum calculation failed, continuing without it', e);
          }

          const response = await uploadRequest<AssetMediaResponseDto>({
            url: getBaseUrl() + '/assets' + (queryParams ? `?${queryParams}` : ''),
            data: metaForm,
          });

          if (![200, 201].includes(response.status)) {
            throw new Error($t('errors.unable_to_upload_file'));
          }

          responseData = response.data;
      } catch (err) {
          console.error('Drive upload failed:', err);
          throw err;
      }
    }

    if (responseData.status === AssetMediaStatus.Duplicate) {
      uploadAssetsStore.track('duplicate');
    } else {
      uploadAssetsStore.track('success');
    }

    if (albumId && !authManager.isSharedLink) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_adding_to_album') });
      await addAssetsToAlbums([albumId], [responseData.id], { notify: false });
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_added_to_album') });
    }

    uploadAssetsStore.updateItem(deviceAssetId, {
      state: responseData.status === AssetMediaStatus.Duplicate ? UploadState.DUPLICATED : UploadState.DONE,
      assetId: responseData.id,
      isTrashed: responseData.isTrashed,
    });

    if (responseData.status !== AssetMediaStatus.Duplicate) {
      setTimeout(() => {
        uploadAssetsStore.removeItem(deviceAssetId);
      }, 1000);
    }

    return responseData.id;
  } catch (error) {
    // If the user store no longer holds a user, it means they have logged out
    // In this case don't bother reporting any errors.
    if (wasInitiallyLoggedIn && !authManager.authenticated) {
      return;
    }

    const errorMessage = handleError(error, $t('errors.unable_to_upload_file'));
    uploadAssetsStore.track('error');
    uploadAssetsStore.updateItem(deviceAssetId, { state: UploadState.ERROR, error: errorMessage });
    return;
  }
}
