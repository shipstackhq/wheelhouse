import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useProject, useProjects } from "../../lib/queries";
import { Projects } from "./projects";
import { ProjectView } from "./project-view";

/** `/projects`: the projects the person can see. */
export function ProjectsPage() {
  const query = useProjects();
  return (
    <Loaded query={query} label="Loading projects">
      {(projects) => <Projects projects={projects} />}
    </Loaded>
  );
}

/** `/projects/:id`: one project, its milestones and teams. */
export function ProjectPage() {
  const { id = "" } = useParams();
  const query = useProject(id);
  return (
    <Loaded query={query} label="Loading the project">
      {(project) => <ProjectView project={project} />}
    </Loaded>
  );
}
