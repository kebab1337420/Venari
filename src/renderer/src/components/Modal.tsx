import { useEffect, useRef, type ReactNode } from 'react'

// Ordre d'ouverture des modales montées. Seule la plus récente doit réagir à
// Échap : sans ce garde-fou, une modale superposée (identifiants, scan) avait
// son propre listener et refermait aussi la modale parente (détail du
// programme). L'ordre est attribué au rendu, parent avant enfant, et non à
// l'exécution des effets qui remonte des enfants vers les parents.
let nextOpenOrder = 0
const openModals = new Set<number>()

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const order = useRef(0)
  if (order.current === 0) order.current = ++nextOpenOrder
  const onCloseRef = useRef(props.onClose)
  onCloseRef.current = props.onClose

  useEffect(() => {
    const mine = order.current
    openModals.add(mine)
    return () => {
      openModals.delete(mine)
    }
  }, [])

  // Fermeture au clavier : Échap referme le modal sans forcer un clic sur le
  // fond ou la croix. Le listener est actif tant que le modal est monté, mais
  // seule la modale du dessus traite l'événement.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (order.current !== Math.max(...openModals)) return
      e.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Le focus atterrit sur la croix à l'ouverture : Tab et Entrée sortent
  // immédiatement, rien ne reste piégé derrière le modal.
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className={`modal ${props.wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3>{props.title}</h3>
          <button ref={closeRef} className="modal-close" onClick={props.onClose} aria-label="Fermer">
            ✕
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  )
}
