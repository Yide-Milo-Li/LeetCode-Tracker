/** Strict event-time validation; legacy ambiguous values remain readable but are not proof. */
import { z } from 'zod';
import { isTimeZone } from './time-utils.ts';

export * from './time-utils.ts';

export const timeZoneSchema = z.string().max(100).refine(isTimeZone, 'A valid IANA time zone is required');
