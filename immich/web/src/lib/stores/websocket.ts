import type {
  AssetResponseDto,
  MaintenanceStatusResponseDto,
  NotificationDto,
  ServerVersionResponseDto,
  SyncAssetEditV1,
  SyncAssetV1,
} from '@immich/sdk';
import { writable } from 'svelte/store';
import type { ReleaseEvent } from '$lib/types';

interface AppRestartEvent {
  isMaintenanceMode: boolean;
}

export interface Events {
  on_upload_success: (asset: AssetResponseDto) => void;
  on_user_delete: (id: string) => void;
  on_asset_delete: (assetId: string) => void;
  on_asset_trash: (assetIds: string[]) => void;
  on_asset_update: (asset: AssetResponseDto) => void;
  on_asset_hidden: (assetId: string) => void;
  on_asset_restore: (assetIds: string[]) => void;
  on_asset_stack_update: (assetIds: string[]) => void;
  on_person_thumbnail: (personId: string) => void;
  on_server_version: (serverVersion: ServerVersionResponseDto) => void;
  on_config_update: () => void;
  on_new_release: (event: ReleaseEvent) => void;
  on_session_delete: (sessionId: string) => void;
  on_notification: (notification: NotificationDto) => void;

  AppRestartV1: (event: AppRestartEvent) => void;

  MaintenanceStatusV1: (event: MaintenanceStatusResponseDto) => void;
  AssetEditReadyV1: (data: { asset: SyncAssetV1; edit: SyncAssetEditV1[] }) => void;
}

// DaemonClient has no real-time WebSocket backend (Firebase Hosting doesn't
// speak WebSocket and the per-user CF worker doesn't run a socket.io server),
// so the socket never connected. socket.io-client is gone from the bundle:
// `websocketEvents` keeps the same API for shared code, but nothing ever emits.

// Pre-seed connected=true and a static server version so the sidebar shows
// "Server Online v2.7.5" instead of "Server Offline / Unknown".
export const websocketStore = {
  connected: writable<boolean>(true),
  serverVersion: writable<ServerVersionResponseDto>({ major: 2, minor: 7, patch: 5 }),
  serverRestarting: writable<undefined | AppRestartEvent>(),
};

const noop = () => {};

export const websocketEvents = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  on: <T extends keyof Events>(event: T, listener: Events[T]): (() => void) => noop,
};

export const openWebsocketConnection = noop;

export const closeWebsocketConnection = noop;

export const waitForWebsocketEvent = <T extends keyof Events>(
  event: T,
  predicate?: (...args: Parameters<Events[T]>) => boolean,
  timeout: number = 10_000,
): Promise<Parameters<Events[T]>> => {
  return new Promise((resolve, reject) => {
    const cleanup = websocketEvents.on(event, ((...args: Parameters<Events[T]>) => {
      if (!predicate || predicate(...args)) {
        cleanup();
        clearTimeout(timer);
        resolve(args);
      }
    }) as Events[T]);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for event: ${String(event)}`));
    }, timeout);
  });
};
