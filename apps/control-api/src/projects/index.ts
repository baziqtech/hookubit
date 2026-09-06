export { ProjectsModule } from './projects.module';
export { ProjectsService } from './projects.service';
export { ProjectsController } from './projects.controller';
export {
  CreateProjectDto,
  ListProjectsQueryDto,
  ProjectDto,
  ProjectListDto,
  UpdateProjectDto,
  toProjectDto,
} from './dto';
export { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN, slugFromName } from './slug';
export { UNIQUE_VIOLATION, isUniqueViolationOn, uniqueViolationTarget } from './unique-violation';
