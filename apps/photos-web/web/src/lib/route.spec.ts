import { OpenQueryParam } from '$lib/constants';
import { Route } from '$lib/route';

describe('Route', () => {
  describe(Route.login.name, () => {
    it('should encode continue', () => {
      expect(Route.login({ continue: '/some/path?with=query', autoLaunch: 1 })).toBe(
        '/auth/login?continue=%2Fsome%2Fpath%3Fwith%3Dquery&autoLaunch=1',
      );
    });
  });

  describe(Route.search.name, () => {
    it('should work', () => {
      expect(Route.search({})).toBe('/search');
    });

    it('should work', () => {
      expect(Route.search({ make: undefined, model: 'Immich' })).toBe('/search?query=%7B%22model%22%3A%22Immich%22%7D');
    });

  });

  describe(Route.tags.name, () => {
    it('should work', () => {
      expect(Route.tags()).toBe('/tags');
    });

    it('should support query parameters', () => {
      expect(Route.tags({ path: '/some/path' })).toBe('/tags?path=%2Fsome%2Fpath');
    });

    it('should ignore an empty path', () => {
      expect(Route.tags({ path: '' })).toBe('/tags');
    });
  });

  describe(Route.userSettings.name, () => {
    it('should work', () => {
      expect(Route.userSettings()).toBe('/user-settings');
    });

    it('should support query parameters', () => {
      expect(Route.userSettings({ isOpen: OpenQueryParam.NOTIFICATIONS })).toBe('/user-settings?isOpen=notifications');
    });
  });

  describe(Route.buy.name, () => {
    it('should open the purchase settings', () => {
      expect(Route.buy()).toBe('/user-settings?isOpen=user-purchase-settings');
    });
  });
});
