import type { TrackerApplication } from '../../../../packages/application/src/application.ts';
import type { DeviceSyncService } from '../sync/sync-service.ts';
import type { OpenAIOAuthService } from '../llm/openai-oauth-service.ts';
import type { ChatService } from '../chat/chat-service.ts';

export interface RouteContext {
  application: TrackerApplication;
  deviceSync: DeviceSyncService;
  /** This device's Sign in with ChatGPT session. */
  openAIOAuth: OpenAIOAuthService;
  /** In-app AI chat over the active provider. */
  chat: ChatService;
  afterBundleRestore: () => void;
}
