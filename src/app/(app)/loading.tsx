import { PageSkeleton } from "@/components/skeleton";

/** Shown inside the app shell (sidebar stays) while any page under it is loading. */
export default function Loading() {
  return <PageSkeleton />;
}
