"""AURIGE - Domaine systeme (apt, alimentation, versions, sauvegardes, mise a jour). Extrait de main.py, routes inchangees.

Les stores apt_output_store / update_output_store restent dans main.py (les tests
patchent main.update_output_store) ; les reaffectations passent par les setters
main._set_apt_output / main._set_update_output.
"""
import asyncio
import os
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

import main

router = APIRouter()


@router.post("/api/system/apt/update")
async def apt_update():
    """Run apt update"""
    if main.apt_output_store["running"]:
        return {"status": "error", "message": "Une commande apt est déjà en cours"}
    
    main._set_apt_output({"lines": [], "running": True, "command": "apt update"})
    
    async def run_apt():
        try:
            process = await asyncio.create_subprocess_exec(
                "sudo", "apt", "update",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                main.apt_output_store["lines"].append(line.decode().strip())
            await process.wait()
            main.apt_output_store["lines"].append(f"--- Terminé (code: {process.returncode}) ---")
        except Exception as e:
            main.apt_output_store["lines"].append(f"Erreur: {str(e)}")
        finally:
            main.apt_output_store["running"] = False
    
    asyncio.create_task(run_apt())
    return {"status": "started", "message": "apt update démarré"}


@router.post("/api/system/apt/upgrade")
async def apt_upgrade():
    """Run apt upgrade -y"""
    if main.apt_output_store["running"]:
        return {"status": "error", "message": "Une commande apt est déjà en cours"}
    
    main._set_apt_output({"lines": [], "running": True, "command": "apt upgrade"})
    
    async def run_apt():
        try:
            process = await asyncio.create_subprocess_exec(
                "sudo", "apt", "upgrade", "-y",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                main.apt_output_store["lines"].append(line.decode().strip())
            await process.wait()
            main.apt_output_store["lines"].append(f"--- Terminé (code: {process.returncode}) ---")
        except Exception as e:
            main.apt_output_store["lines"].append(f"Erreur: {str(e)}")
        finally:
            main.apt_output_store["running"] = False
    
    asyncio.create_task(run_apt())
    return {"status": "started", "message": "apt upgrade démarré"}


@router.get("/api/system/apt/output")
async def get_apt_output():
    """Get apt command output"""
    return {
        "running": main.apt_output_store["running"],
        "command": main.apt_output_store["command"],
        "lines": main.apt_output_store["lines"],
    }


@router.post("/api/system/reboot")
async def system_reboot():
    """Reboot the Raspberry Pi"""
    try:
        # Schedule reboot in 2 seconds to allow response
        asyncio.create_task(asyncio.create_subprocess_exec("sudo", "shutdown", "-r", "+0"))
        return {"status": "success", "message": "Redémarrage en cours..."}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("/api/system/shutdown")
async def system_shutdown():
    """Shutdown the Raspberry Pi"""
    try:
        asyncio.create_task(asyncio.create_subprocess_exec("sudo", "shutdown", "-h", "+0"))
        return {"status": "success", "message": "Arrêt en cours..."}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/api/system/branches")
async def get_git_branches():
    """List remote branches from GitHub repo"""
    GITHUB_REPO = "https://github.com/Yo-ETE/v0-aurige-ui-design.git"
    INSTALLED_REPO = "/opt/aurige/repo"
    repo_to_check = INSTALLED_REPO if Path(f"{INSTALLED_REPO}/.git").exists() else main.GIT_REPO_PATH
    
    try:
        # Try to get branches from an existing local repo first (faster)
        if Path(f"{repo_to_check}/.git").exists():
            main.run_command(["git", "config", "--global", "--add", "safe.directory", repo_to_check], check=False)
            main.run_command(["git", "-C", repo_to_check, "fetch", "--prune", "origin"], check=False)
            result = main.run_command(["git", "-C", repo_to_check, "branch", "-r", "--format=%(refname:short)"], check=False)
            if result.returncode == 0 and result.stdout.strip():
                branches = []
                for line in result.stdout.strip().split("\n"):
                    branch = line.strip()
                    if branch and not branch.endswith("/HEAD"):
                        # Remove "origin/" prefix
                        branch_name = branch.replace("origin/", "", 1) if branch.startswith("origin/") else branch
                        if branch_name:
                            branches.append(branch_name)
                
                # Get currently saved branch preference
                saved_branch = ""
                saved_branch_file = Path("/opt/aurige/branch.txt")
                if saved_branch_file.exists():
                    saved_branch = saved_branch_file.read_text().strip()

                return {
                    "branches": sorted(set(branches)),
                    "current": saved_branch or "main",
                }
        
        # Fallback: use git ls-remote (works without local clone)
        result = main.run_command(["git", "ls-remote", "--heads", GITHUB_REPO], check=False)
        if result.returncode == 0 and result.stdout.strip():
            branches = []
            for line in result.stdout.strip().split("\n"):
                parts = line.strip().split("\t")
                if len(parts) == 2:
                    ref = parts[1]
                    branch_name = ref.replace("refs/heads/", "")
                    if branch_name:
                        branches.append(branch_name)
            
            saved_branch = ""
            saved_branch_file = Path("/opt/aurige/branch.txt")
            if saved_branch_file.exists():
                saved_branch = saved_branch_file.read_text().strip()

            return {
                "branches": sorted(branches),
                "current": saved_branch or "main",
            }
        
        return {"branches": [], "current": "", "error": "Impossible de lister les branches"}
    except Exception as e:
        return {"branches": [], "current": "", "error": str(e)}


@router.get("/api/system/version")
async def get_system_version():
    """Get current git version info - checks installed version in /opt/aurige/repo"""
    # Prefer the installed repo over /tmp/aurige
    INSTALLED_REPO = "/opt/aurige/repo"
    repo_to_check = INSTALLED_REPO if Path(f"{INSTALLED_REPO}/.git").exists() else main.GIT_REPO_PATH
    
    try:
        # Check if git repo exists
        if not Path(repo_to_check).exists() or not Path(f"{repo_to_check}/.git").exists():
            return {"branch": "non installe", "commit": "-", "commitsBehind": 0, "updateAvailable": False, "error": "Aucun depot git trouve"}
        
        # Add safe.directory to avoid "dubious ownership" error
        main.run_command(["git", "config", "--global", "--add", "safe.directory", repo_to_check], check=False)
        
        # Get current branch
        branch_result = main.run_command(["git", "-C", repo_to_check, "branch", "--show-current"], check=False)
        branch = branch_result.stdout.strip() if branch_result.returncode == 0 else "unknown"
        
        # Also check saved branch preference
        saved_branch_file = Path("/opt/aurige/branch.txt")
        saved_branch = ""
        if saved_branch_file.exists():
            saved_branch = saved_branch_file.read_text().strip()
        
        # Get current commit hash
        commit_result = main.run_command(["git", "-C", repo_to_check, "rev-parse", "--short", "HEAD"], check=False)
        commit = commit_result.stdout.strip() if commit_result.returncode == 0 else "unknown"
        
        # Get commit date
        date_result = main.run_command(["git", "-C", repo_to_check, "log", "-1", "--format=%ci"], check=False)
        commit_date = date_result.stdout.strip() if date_result.returncode == 0 else ""

        # Message + auteur du commit courant (parité Theia)
        msg_result = main.run_command(["git", "-C", repo_to_check, "log", "-1", "--format=%s"], check=False)
        commit_message = msg_result.stdout.strip() if msg_result.returncode == 0 else ""
        author_result = main.run_command(["git", "-C", repo_to_check, "log", "-1", "--format=%an"], check=False)
        commit_author = author_result.stdout.strip() if author_result.returncode == 0 else ""

        # Check if there are updates available by fetching from remote
        main.run_command(["git", "-C", repo_to_check, "fetch", "origin"], check=False)
        
        # Use saved branch preference or current branch
        check_branch = saved_branch or branch
        remote_branch = f"origin/{check_branch}" if check_branch and check_branch != "unknown" else "origin/main"
        behind_result = main.run_command(["git", "-C", repo_to_check, "rev-list", "--count", f"HEAD..{remote_branch}"], check=False)
        
        # If that fails (branch doesn't exist on remote), try origin/main
        if behind_result.returncode != 0 or not behind_result.stdout.strip().isdigit():
            remote_branch = "origin/main"
            behind_result = main.run_command(["git", "-C", repo_to_check, "rev-list", "--count", "HEAD..origin/main"], check=False)
        
        commits_behind = int(behind_result.stdout.strip()) if behind_result.returncode == 0 and behind_result.stdout.strip().isdigit() else 0

        # Liste des 10 derniers commits de la branche distante (parité Theia).
        # Format %h|%s|%ai|%an, split sur "|" (maxsplit 3 : le message peut en contenir).
        latest_commits = []
        log_result = main.run_command(
            ["git", "-C", repo_to_check, "log", remote_branch,
             "--pretty=format:%h|%s|%ai|%an", "--max-count=10"],
            check=False,
        )
        if log_result.returncode == 0 and log_result.stdout.strip():
            for line in log_result.stdout.strip().split("\n"):
                parts = line.split("|", 3)
                if len(parts) == 4:
                    latest_commits.append({
                        "hash": parts[0],
                        "message": parts[1],
                        "date": parts[2][:16],
                        "author": parts[3],
                    })

        return {
            "branch": saved_branch or branch,
            "commit": commit,
            "commitDate": commit_date,
            "commitMessage": commit_message,
            "commitAuthor": commit_author,
            "commitsBehind": commits_behind,
            "updateAvailable": commits_behind > 0,
            "latestCommits": latest_commits,
            "repoPath": repo_to_check,
        }
    except Exception as e:
        return {"branch": "unknown", "commit": "unknown", "error": str(e)}


@router.get("/api/system/data-info")
async def get_data_info():
    """Get info about the data directory for debugging"""
    try:
        data_files = []
        total_size = 0
        for f in main.DATA_DIR.rglob("*"):
            if f.is_file():
                size = f.stat().st_size
                total_size += size
                data_files.append({
                    "path": str(f.relative_to(main.DATA_DIR)),
                    "size": size,
                })
        
        return {
            "dataDir": str(main.DATA_DIR),
            "exists": main.DATA_DIR.exists(),
            "fileCount": len(data_files),
            "totalSize": total_size,
            "files": data_files[:50],  # Limit to first 50 files
        }
    except Exception as e:
        return {"error": str(e), "dataDir": str(main.DATA_DIR)}


@router.get("/api/system/backups")
async def list_backups():
    """List available backup files"""
    try:
        backup_dir = Path("/opt/aurige")
        backups = []
        for f in backup_dir.glob("data-backup-*.tar.gz"):
            # Use stat command to get file size (works better with sudo-created files)
            stat_result = main.run_command(["stat", "-c", "%s %Y", str(f)], check=False)
            if stat_result.returncode == 0:
                parts = stat_result.stdout.strip().split()
                size = int(parts[0]) if parts else 0
                mtime = int(parts[1]) if len(parts) > 1 else 0
            else:
                try:
                    stat = f.stat()
                    size = stat.st_size
                    mtime = int(stat.st_mtime)
                except:
                    size = 0
                    mtime = 0
            
            backups.append({
                "filename": f.name,
                "size": size,
                "created": datetime.fromtimestamp(mtime).isoformat() if mtime else "",
            })
        backups.sort(key=lambda x: x["created"], reverse=True)
        return {"backups": backups}
    except Exception as e:
        return {"backups": [], "error": str(e)}


@router.post("/api/system/backup")
async def create_backup():
    """Create a backup of the data directory"""
    try:
        timestamp = datetime.now().strftime("%Y-%m-%d-%H%M")
        backup_file = f"/opt/aurige/data-backup-{timestamp}.tar.gz"
        
        # Use the actual main.DATA_DIR that the app uses
        data_dir = main.DATA_DIR
        parent_dir = data_dir.parent  # /opt/aurige
        data_folder_name = data_dir.name  # data
        
        # Check if data directory exists
        if not data_dir.exists():
            return {"status": "error", "message": f"Le dossier {data_dir} n'existe pas"}
        
        # Check if data directory has any content
        data_files = list(data_dir.rglob("*"))
        file_count = len([f for f in data_files if f.is_file()])
        
        # Calculate total size before backup
        total_size = sum(f.stat().st_size for f in data_files if f.is_file())
        
        if file_count == 0:
            return {"status": "error", "message": f"Le dossier {data_dir} est vide, rien a sauvegarder"}
        
        # Create backup - use tar with sudo to ensure we can read all files
        result = main.run_command([
            "sudo", "tar", "-czf", backup_file, "-C", str(parent_dir), data_folder_name
        ], check=False)
        
        # Fix permissions so we can read it
        if result.returncode == 0:
            main.run_command(["sudo", "chmod", "644", backup_file], check=False)
        
        if result.returncode == 0:
            # Get file size
            try:
                size = Path(backup_file).stat().st_size
            except:
                stat_result = main.run_command(["stat", "-c", "%s", backup_file], check=False)
                size = int(stat_result.stdout.strip()) if stat_result.returncode == 0 else 0
            
            return {
                "status": "success",
                "message": f"Sauvegarde creee ({file_count} fichiers, {total_size/1024:.1f} Ko source)",
                "filename": f"data-backup-{timestamp}.tar.gz",
                "size": size,
            }
        else:
            return {"status": "error", "message": f"Erreur tar: {result.stderr or result.stdout}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.delete("/api/system/backups/{filename}")
async def delete_backup(filename: str):
    """Delete a backup file"""
    try:
        # Security: only allow deleting backup files with proper naming
        if not filename.startswith("data-backup-") or not filename.endswith(".tar.gz"):
            raise HTTPException(status_code=400, detail="Nom de fichier invalide")
        
        backup_path = Path("/opt/aurige") / filename
        if not backup_path.exists():
            raise HTTPException(status_code=404, detail="Sauvegarde introuvable")
        
        # Try normal delete, then sudo if needed
        try:
            backup_path.unlink()
        except PermissionError:
            main.run_command(["sudo", "rm", str(backup_path)], check=False)
        
        return {"status": "success", "message": f"Sauvegarde {filename} supprimee"}
    except HTTPException:
        raise
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("/api/system/backups/{filename}/restore")
async def restore_backup(filename: str):
    """Restore a backup file"""
    try:
        # Security: only allow restoring backup files with proper naming
        if not filename.startswith("data-backup-") or not filename.endswith(".tar.gz"):
            raise HTTPException(status_code=400, detail="Nom de fichier invalide")
        
        backup_path = Path("/opt/aurige") / filename
        if not backup_path.exists():
            raise HTTPException(status_code=404, detail="Sauvegarde introuvable")
        
        # Extract backup to /opt/aurige (will overwrite data folder)
        result = main.run_command([
            "sudo", "tar", "-xzf", str(backup_path), "-C", "/opt/aurige"
        ], check=False)
        
        if result.returncode == 0:
            return {"status": "success", "message": f"Sauvegarde {filename} restauree. Redemarrez les services."}
        else:
            return {"status": "error", "message": result.stderr or "Erreur lors de la restauration"}
    except HTTPException:
        raise
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/api/system/backups/{filename}/download")
async def download_backup(filename: str):
    """Télécharger une archive de sauvegarde (parité Theia)."""
    if not main.valid_backup_filename(filename):
        raise HTTPException(status_code=400, detail="Nom de fichier invalide")
    backup_path = Path("/opt/aurige") / filename
    if not backup_path.exists():
        raise HTTPException(status_code=404, detail="Sauvegarde introuvable")
    return FileResponse(
        path=str(backup_path),
        media_type="application/gzip",
        filename=filename,
    )


@router.post("/api/system/backups/upload")
async def upload_backup(file: UploadFile = File(...)):
    """Importer une archive de sauvegarde (.tar.gz) depuis le poste client (parité Theia).

    Restauration sur un Pi neuf apres crash/reinstallation : importer puis restaurer.
    """
    MAX_BYTES = 500 * 1024 * 1024  # 500 Mo
    # Nom de destination : on garde un nom conforme au motif data-backup-*.tar.gz,
    # sinon on genere un nom sur depuis l'horodatage (jamais le nom client brut).
    orig = os.path.basename(file.filename or "")
    if main.valid_backup_filename(orig):
        dest_name = orig
    else:
        ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        dest_name = f"data-backup-import-{ts}.tar.gz"
    dest_path = Path("/opt/aurige") / dest_name

    # Ecriture en flux avec plafond de taille (evite de saturer le disque du Pi).
    total = 0
    try:
        with open(dest_path, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_BYTES:
                    out.close()
                    dest_path.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="Fichier trop volumineux (max 500 Mo)")
                out.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        dest_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Ecriture echouee: {e}")

    # Verifier que c'est bien une archive tar.gz valide avant de l'accepter.
    verify = main.run_command(["tar", "-tzf", str(dest_path)], check=False, timeout=60)
    if verify.returncode != 0:
        dest_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Archive invalide (tar -tzf a echoue)")

    main.run_command(["sudo", "chmod", "644", str(dest_path)], check=False)
    try:
        size = dest_path.stat().st_size
    except Exception:
        size = total
    return {"status": "success", "filename": dest_name, "size": size, "message": f"Sauvegarde importee: {dest_name}"}


@router.post("/api/system/update")
async def start_update(request: Request):
    """Start update by fresh clone and install script. Optionally accepts JSON body with {branch: "..."} """
    # Garde : valider la branche demandee avant toute ecriture / planification
    try:
        _guard_body = await request.json()
    except Exception:
        _guard_body = None
    _branch = _guard_body.get("branch") if isinstance(_guard_body, dict) else None
    if _branch and not main.valid_git_ref(_branch):
        raise HTTPException(status_code=400, detail="Branche invalide")
    _commit = _guard_body.get("commit") if isinstance(_guard_body, dict) else None
    if _commit and not main.valid_git_ref(_commit):
        raise HTTPException(status_code=400, detail="Commit invalide")
    if main.update_output_store["running"]:
        return {"status": "error", "message": "Une mise à jour est déjà en cours"}
    
    main._set_update_output({"lines": [], "running": True, "command": "update"})
    
    # GitHub repo URL and target branch
    GITHUB_REPO = "https://github.com/Yo-ETE/v0-aurige-ui-design.git"
    TARGET_BRANCH = "main"
    TARGET_COMMIT = None  # commit precis a deployer (parité Theia), optionnel

    # Check if a specific branch / commit was requested in the body
    try:
        body = await request.json()
        if body.get("branch"):
            TARGET_BRANCH = body["branch"]
            # Save the branch preference immediately
            save_branch_file = Path("/opt/aurige/branch.txt")
            try:
                save_branch_file.parent.mkdir(parents=True, exist_ok=True)
                save_branch_file.write_text(TARGET_BRANCH)
            except:
                pass
        if body.get("commit"):
            TARGET_COMMIT = body["commit"]
    except:
        pass
    
    # If no branch in body, check for saved branch preference
    if TARGET_BRANCH == "main":
        saved_branch_file = Path("/opt/aurige/branch.txt")
        if saved_branch_file.exists():
            saved = saved_branch_file.read_text().strip()
            if saved:
                TARGET_BRANCH = saved
    
    async def run_update():
        try:
            # Note: We do NOT stop services here - install_pi.sh handles that
            # Stopping here would cause 502 errors for the frontend

            # Step 1+2: Mise a jour EN PLACE du depot.
            # IMPORTANT: aurige-web tourne depuis /opt/aurige/repo. Un `rm -rf`
            # du dossier casserait le frontend servi pendant toute la MAJ (et
            # definitivement si le build echoue). On fait donc `git fetch` en
            # place quand le depot existe, et on ne clone QUE s'il est absent.
            if os.path.isdir(os.path.join(main.GIT_REPO_PATH, ".git")):
                main.update_output_store["lines"].append(">>> Depot existant : git fetch origin...")
                fetch_proc = await asyncio.create_subprocess_exec(
                    "sudo", "git", "-C", main.GIT_REPO_PATH, "fetch", "origin",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
                while True:
                    line = await fetch_proc.stdout.readline()
                    if not line:
                        break
                    text = line.decode().strip()
                    if text:
                        main.update_output_store["lines"].append(text)
                await fetch_proc.wait()
                if fetch_proc.returncode != 0:
                    main.update_output_store["lines"].append(f"[ERROR] git fetch a echoue (code: {fetch_proc.returncode})")
                    main.update_output_store["running"] = False
                    return
                main.update_output_store["lines"].append("[OK] Fetch termine")
            else:
                main.update_output_store["lines"].append(">>> Depot absent : clonage depuis GitHub...")
                clone_proc = await asyncio.create_subprocess_exec(
                    "sudo", "git", "clone", GITHUB_REPO, main.GIT_REPO_PATH,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
                while True:
                    line = await clone_proc.stdout.readline()
                    if not line:
                        break
                    text = line.decode().strip()
                    if text:
                        main.update_output_store["lines"].append(text)
                await clone_proc.wait()
                if clone_proc.returncode != 0:
                    main.update_output_store["lines"].append(f"[ERROR] Erreur de clonage (code: {clone_proc.returncode})")
                    main.update_output_store["running"] = False
                    return
                main.update_output_store["lines"].append("[OK] Depot clone")
            
            # Step 3: Checkout the target branch
            # After a fresh clone, remote branches are origin/<name>
            # Use -B to create/force local branch tracking the remote
            main.update_output_store["lines"].append(f">>> Checkout de la branche {TARGET_BRANCH}...")
            checkout_proc = await asyncio.create_subprocess_exec(
                "sudo", "git", "-C", main.GIT_REPO_PATH, "checkout", "-B", TARGET_BRANCH, f"origin/{TARGET_BRANCH}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            while True:
                line = await checkout_proc.stdout.readline()
                if not line:
                    break
                text = line.decode().strip()
                if text:
                    main.update_output_store["lines"].append(text)
            await checkout_proc.wait()
            
            if checkout_proc.returncode != 0:
                # Try direct checkout (works for branches like main)
                main.update_output_store["lines"].append(f">>> -B echoue, essai checkout direct {TARGET_BRANCH}...")
                checkout2_proc = await asyncio.create_subprocess_exec(
                    "sudo", "git", "-C", main.GIT_REPO_PATH, "checkout", TARGET_BRANCH,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
                await checkout2_proc.wait()
                if checkout2_proc.returncode != 0:
                    main.update_output_store["lines"].append(f">>> Branche {TARGET_BRANCH} non trouvee, utilisation de main")
                    fallback_proc = await asyncio.create_subprocess_exec(
                        "sudo", "git", "-C", main.GIT_REPO_PATH, "checkout", "main",
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                    )
                    await fallback_proc.wait()
                else:
                    main.update_output_store["lines"].append(f"[OK] Branche {TARGET_BRANCH}")
            else:
                main.update_output_store["lines"].append(f"[OK] Branche {TARGET_BRANCH}")
            
            # Save branch preference to branch.txt before install_pi.sh runs
            save_branch_proc = await asyncio.create_subprocess_exec(
                "sudo", "bash", "-c", f"echo '{TARGET_BRANCH}' > /opt/aurige/branch.txt",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            await save_branch_proc.wait()
            main.update_output_store["lines"].append(f"[OK] branch.txt sauvegarde: {TARGET_BRANCH}")

            # Step 3b: si un commit precis est demande (parité Theia), checkout
            # de ce commit (HEAD detache) apres avoir positionne la branche.
            if TARGET_COMMIT:
                main.update_output_store["lines"].append(f">>> Checkout du commit {TARGET_COMMIT}...")
                co_commit = await asyncio.create_subprocess_exec(
                    "sudo", "git", "-C", main.GIT_REPO_PATH, "checkout", TARGET_COMMIT,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
                while True:
                    line = await co_commit.stdout.readline()
                    if not line:
                        break
                    text = line.decode().strip()
                    if text:
                        main.update_output_store["lines"].append(text)
                await co_commit.wait()
                if co_commit.returncode != 0:
                    main.update_output_store["lines"].append(f"[ERROR] Commit {TARGET_COMMIT} introuvable")
                    main.update_output_store["running"] = False
                    return
                main.update_output_store["lines"].append(f"[OK] Commit {TARGET_COMMIT}")

            # Step 4: Run install script (this will stop/restart services at the end)
            main.update_output_store["lines"].append(">>> Execution du script d'installation...")
            main.update_output_store["lines"].append(">>> (Les services redemarreront automatiquement)")
            
            process = await asyncio.create_subprocess_exec(
                "sudo", "bash", f"{main.GIT_REPO_PATH}/scripts/install_pi.sh",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=main.GIT_REPO_PATH,
            )
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                decoded = line.decode().strip()
                if decoded:
                    main.update_output_store["lines"].append(decoded)
            await process.wait()
            
            if process.returncode != 0:
                main.update_output_store["lines"].append(f"[ERROR] Erreur install_pi.sh (code: {process.returncode})")

            # GARDE-FOU anti-page-blanche : ne redemarrer aurige-web QUE si le
            # build frontend a reellement produit .next/BUILD_ID. Sinon on garde
            # l'ancienne version en ligne (pas de page blanche).
            build_id_path = os.path.join(main.GIT_REPO_PATH, ".next", "BUILD_ID")
            if not os.path.isfile(build_id_path):
                main.update_output_store["lines"].append(
                    "[ERROR] Build frontend absent (.next/BUILD_ID manquant). "
                    "Redemarrage ANNULE pour eviter une page blanche : l'ancienne version reste en ligne."
                )
                return

            main.update_output_store["lines"].append("[OK] Build frontend verifie (.next/BUILD_ID present)")
            main.update_output_store["lines"].append("[OK] Mise a jour terminee!")
            main.update_output_store["lines"].append(">>> Redemarrage automatique des services dans 3 secondes...")

            # Use systemd-run to create a completely independent transient service
            # This survives when aurige-api is killed

            # Create restart script
            restart_script = "/tmp/aurige_restart_services.sh"
            with open(restart_script, "w") as f:
                f.write("#!/bin/bash\n")
                f.write("sleep 3\n")
                f.write("systemctl restart aurige-web.service\n")
                f.write("sleep 2\n")
                f.write("systemctl restart aurige-api.service\n")
            os.chmod(restart_script, 0o755)

            # Use systemd-run to execute the script as a transient service
            result = main.subprocess.run(
                ["systemd-run", "--no-block", "--collect", "--unit=aurige-restart-temp", "/bin/bash", restart_script],
                capture_output=True,
                text=True
            )

            if result.returncode == 0:
                main.update_output_store["lines"].append("[OK] Services vont redemarrer automatiquement. Rechargez la page dans 5-10 secondes.")
            else:
                # Fallback: try with at command
                at_result = main.subprocess.run(
                    ["bash", "-c", f"echo '{restart_script}' | at now + 1 minute 2>/dev/null || echo 'at failed'"],
                    capture_output=True,
                    text=True
                )
                if "at failed" not in at_result.stdout:
                    main.update_output_store["lines"].append("[OK] Services vont redemarrer dans 1 minute. Rechargez la page.")
                else:
                    main.update_output_store["lines"].append("[WARNING] Redemarrage auto echoue. Utilisez le bouton 'Redemarrer services'.")
            
        except Exception as e:
            main.update_output_store["lines"].append(f"[ERROR] {str(e)}")
        finally:
            main.update_output_store["running"] = False
    
    asyncio.create_task(run_update())
    return {"status": "started", "message": "Mise à jour démarrée"}


@router.get("/api/system/update/output")
async def get_update_output():
    """Get update command output"""
    lines = main.update_output_store["lines"]
    # Determine success/error status
    success = any("[OK] Mise a jour terminee" in line for line in lines)
    error = any("[ERROR]" in line for line in lines)
    
    return {
        "running": main.update_output_store["running"],
        "lines": lines,
        "success": success and not error,
        "error": "Erreur lors de la mise a jour" if error else None,
    }


@router.post("/api/system/restart-services")
async def restart_services():
    """Restart Aurige services (API and Web)"""
    try:
        results = []
        for service in ["aurige-api", "aurige-web"]:
            result = main.run_command(["sudo", "systemctl", "restart", service], check=False)
            if result.returncode == 0:
                results.append(f"{service}: OK")
            else:
                results.append(f"{service}: Erreur")
        return {"status": "success", "message": f"Services redemarres: {', '.join(results)}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/api/system/check-update")
async def check_update():
    """Check if there's a new version available via git"""
    try:
        repo_dir = Path("/opt/aurige/repo")
        if not repo_dir.exists():
            return {"has_update": False, "message": "No git repo found"}
        
        # Fetch latest
        main.subprocess.run(["git", "fetch", "origin"], cwd=repo_dir, capture_output=True)
        
        # Compare with remote
        local = main.subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo_dir, capture_output=True, text=True)
        remote = main.subprocess.run(["git", "rev-parse", "origin/HEAD"], cwd=repo_dir, capture_output=True, text=True)
        
        local_hash = local.stdout.strip()
        remote_hash = remote.stdout.strip()
        
        return {
            "has_update": local_hash != remote_hash,
            "local_version": local_hash[:8],
            "remote_version": remote_hash[:8] if remote_hash else "unknown"
        }
    except Exception as e:
        return {"has_update": False, "error": str(e)}
