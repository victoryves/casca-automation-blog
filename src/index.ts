/**
 * CASCA Editorial Agent
 *
 * Main entry point for the application.
 */

import { WorkflowOrchestrator } from './orchestrator/workflow.js';

export { WorkflowOrchestrator };

// Export all modules
export { DiscoveryModule } from './modules/discovery/index.js';
export { VerificationModule } from './modules/verification/index.js';
export { SynthesisModule } from './modules/synthesis/index.js';
export { VisualModule } from './modules/visual/index.js';
export { EmailModule } from './modules/email/index.js';
export { EmergencyFallbackModule } from './modules/emergency/index.js';
export { PublishingModule } from './modules/publishing/index.js';

// Export database operations
export * from './db/operations/index.js';

// Export utilities
export { Logger } from './utils/logger.js';
export { getConfig, loadConfig } from './config/index.js';

// Export types
export * from './types/index.js';
