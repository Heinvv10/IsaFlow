-- Plan 4 / AFS Export — image library per company
CREATE TABLE IF NOT EXISTS afs_uploaded_images (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  filename        TEXT        NOT NULL,
  url             TEXT        NOT NULL,
  tag             VARCHAR(20) NOT NULL
                                CHECK (tag IN ('cover','section_divider','inline')),
  width_px        INT,
  height_px       INT,
  dpi             INT,
  low_res_warning BOOLEAN     NOT NULL DEFAULT FALSE,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS afs_uploaded_images_company_id_idx ON afs_uploaded_images(company_id);
CREATE INDEX IF NOT EXISTS afs_uploaded_images_tag_idx        ON afs_uploaded_images(company_id, tag);
