import { McpApp, Module, ConfigModule } from '@nitrostack/core';
import { AssetsModule } from './modules/assets/assets.module.js';
import { SeismicModule } from './modules/seismic/seismic.module.js';
import { HazardsModule } from './modules/hazards/hazards.module.js';
import { OpsModule } from './modules/ops/ops.module.js';
import { SystemHealthCheck } from './health/system.health.js';

/**
 * Atlas Sentinel — root module.
 * Four feature modules: asset registry, seismic channel, hazard channels
 * (weather / space / news), and ops orchestration (sweep + sitrep + prompts).
 */
@McpApp({
  module: AppModule,
  server: { name: 'atlas-sentinel', version: '1.0.0' },
  logging: { level: 'info' }
})
@Module({
  name: 'app',
  description: 'Atlas Sentinel — real-time threat monitoring for factories and supply chains',
  imports: [ConfigModule.forRoot(), AssetsModule, SeismicModule, HazardsModule, OpsModule],
  providers: [SystemHealthCheck]
})
export class AppModule {}
