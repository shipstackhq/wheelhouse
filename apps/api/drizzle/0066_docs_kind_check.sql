ALTER TABLE "docs" ADD CONSTRAINT "docs_kind_check" CHECK ("kind" in ('markdown', 'drawing'));
