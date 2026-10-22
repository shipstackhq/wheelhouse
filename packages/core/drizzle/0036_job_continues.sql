-- "Continue" on a run on a device: a run can carry on from an earlier one, on its branch and from its commits.
ALTER TABLE "device_jobs" ADD COLUMN "continues_job_id" uuid;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD CONSTRAINT "device_jobs_continues_job_id_device_jobs_id_fk" FOREIGN KEY ("continues_job_id") REFERENCES "public"."device_jobs"("id") ON DELETE set null ON UPDATE no action;