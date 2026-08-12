/** Immutable authorization boundary for the local Lumos production profile. */
export const LUMOS_PROFILE = 'lumos';
export const LUMOS_OWNER_OPEN_ID = 'ou_9c50b535153004480e6c305960c4a570';

/** Other profiles keep their normal configurable access policy. */
export function isLumosOwnerAuthorized(profile: string, actorOpenId: string | undefined): boolean {
  return profile !== LUMOS_PROFILE || actorOpenId === LUMOS_OWNER_OPEN_ID;
}
