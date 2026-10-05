import { defaultProvider, screencastManager, themeManager, ThemePreference, type ActionItem } from '@immich/ui';
import { mdiKeyboard, mdiThemeLightDark } from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { page } from '$app/state';
import { copyToClipboard } from '$lib/utils';

const getMyImmichLink = () => {
  return new URL(page.url.pathname + page.url.search, 'https://my.immich.app');
};

export const getSettingsProvider = ($t: MessageFormatter) => {
  const settings: ActionItem[] = [
    {
      title: $t('theme'),
      description: $t('toggle_theme_description'),
      icon: mdiThemeLightDark,
      onAction: () => themeManager.toggle(),
      shortcuts: { shift: true, key: 't' },
    },
    {
      title: $t('system_theme'),
      description: $t('system_theme_command_description', {
        values: { value: themeManager.prefersDark ? $t('dark') : $t('light') },
      }),
      icon: mdiThemeLightDark,
      onAction: () => themeManager.setPreference(ThemePreference.System),
    },
    {
      title: $t('screencast_mode_title'),
      description: $t('screencast_mode_description'),
      icon: mdiKeyboard,
      onAction: () => screencastManager.toggle(),
    },
    {
      title: $t('my_immich_title'),
      description: $t('my_immich_description'),
      onAction: () => copyToClipboard(getMyImmichLink().toString()),
      shortcuts: { ctrl: true, shift: true, key: 'm' },
    },
  ];

  return defaultProvider({ name: $t('command'), actions: settings });
};
