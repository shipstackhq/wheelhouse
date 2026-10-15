import { PageSkeleton } from "@/components/skeleton";

/** Inside a project: the header and tabs stay on screen, only the page body is a placeholder. */
export default function Loading() {
  return <PageSkeleton inset label="Loading project page" />;
}
