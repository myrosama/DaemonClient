import { describe, it, expect } from 'vitest';
import { toAlbumDto } from './albums';

// Regression: the Immich mobile app's AlbumResponseDto.fromJson null-checks
// required fields. A missing `ownerId` or an incomplete `owner` UserResponseDto
// crashed createAlbum with "Null check operator used on a null value".
describe('toAlbumDto', () => {
  it('includes ownerId and a COMPLETE owner UserResponseDto', () => {
    const dto = toAlbumDto({
      id: 'alb1', albumName: 'My Album', createdAt: '2026-06-21T00:00:00Z',
      updatedAt: '2026-06-21T00:00:00Z', assetCount: 3, ownerId: 'u1',
      owner: { id: 'u1', email: 'a@b.com', name: 'a' },
    });
    expect(dto.ownerId).toBe('u1');
    // Every field the mobile UserResponseDto.fromJson null-checks must be present.
    const owner = dto.owner as Record<string, unknown>;
    for (const k of ['id', 'email', 'name', 'avatarColor', 'profileImagePath', 'profileChangedAt', 'isAdmin', 'createdAt', 'updatedAt', 'status']) {
      expect(owner[k]).not.toBeUndefined();
    }
    expect(dto.owner.avatarColor).toBe('primary');
    expect(dto.owner.profileImagePath).toBe('');
    expect(dto.order).toBe('desc');
  });

  it('still produces ownerId when only a partial owner is given', () => {
    const dto = toAlbumDto({ id: 'a', albumName: 'x', owner: { id: 'u9' } });
    expect(dto.ownerId).toBe('u9');
    expect(dto.owner.id).toBe('u9');
  });
});
