import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Tue l'outil *et* sa descendance. ffuf, nuclei et httpx lancent des
 * sous-processus ; tuer seulement le pid direct laisserait un scan orphelin
 * continuer le travail sans contrôle ni arrêt possible.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // taskkill /T tue l'arbre de processus ; on garde le repli direct.
    const fallback = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* deja mort */
      }
    }
    const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false })
    tk.on('error', fallback)
    tk.on('exit', (code) => {
      if (code !== 0 && code !== null) fallback()
    })
    return
  }
  // detached: true fait de l'enfant le meneur de son groupe : le pid negatif
  // cible le groupe entier.
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* deja mort */
    }
  }
  // Escalade si l'outil ignore SIGTERM.
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Groupe déjà disparu, ou enfant non détaché (run_tool) : on retombe
      // sur le pid direct plutôt que de laisser un processus survivre.
      try {
        child.kill('SIGKILL')
      } catch {
        /* déjà mort */
      }
    }
  }, 3000).unref()
}
