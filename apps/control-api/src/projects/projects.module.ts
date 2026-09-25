import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectTemplateService } from './project-template.service';
import { ProjectsService } from './projects.service';

/**
 * No imports: `AuthzModule` is `@Global` and re-exports `AuthModule`, so
 * `TenantScopeFactory`, `AuditService`, `TenantGuard` and `SessionGuard` all
 * resolve here already. `PrismaModule` is deliberately absent - this module has
 * no business holding the unscoped client, and `.eslintrc.json` enforces that.
 */
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectTemplateService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
