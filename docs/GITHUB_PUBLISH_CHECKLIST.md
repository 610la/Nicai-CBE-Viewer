# GitHub Publish Checklist

## Before First Commit

1. Confirm the source root:

```bash
pwd
```

2. Initialize Git from the project folder:

```bash
git init
```

3. Check that ignored local assets are really ignored:

```bash
git status --short
git check-ignore -v out_godwar_record/godwar_record_probe.json
```

4. Run the lightweight syntax check:

```bash
npm run check:js
```

5. Optional: run the publish script safety check:

```powershell
.\scripts\publish_to_github.ps1 -CheckOnly
```

6. Keep generated outputs, logs, and diagnostic screenshots out of the commit.
   If CBE/system files are intentionally published, keep them only under
   `cbe file/` and `nicai system files/`.

## One-Step Publish

After creating an empty GitHub repository, run:

```powershell
.\scripts\publish_to_github.ps1
```

Or double-click:

```text
scripts/DOUBLE_CLICK_PUBLISH_TO_GITHUB.bat
```

## Suggested First Commit

```bash
git add README.md README_EN.md docs src viewer tools scripts package.json "cbe file" "nicai system files" .gitignore .gitattributes .editorconfig
git status --short
git commit -m "Initial CBE emulator research toolkit"
```

Review `git status --short` before committing. The list should be mostly source
files, docs, `cbe file/`, and `nicai system files/`; `out_*`, screenshots, and
logs should not appear.

## License

Choose a license only when you are ready. The repository code can have an
open-source license, but that does not cover original commercial game data or
phone firmware assets.
