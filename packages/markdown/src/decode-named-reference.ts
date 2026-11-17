/** Use the same entity table as the package's worker export without accessing the DOM. */
import { characterEntities } from 'character-entities';

/** Decode a named HTML entity using the same table in Node, browsers, and workers. */
export function decodeNamedCharacterReference(value: string): string | false {
  return Object.hasOwn(characterEntities, value)
    ? characterEntities[value as keyof typeof characterEntities]
    : false;
}
