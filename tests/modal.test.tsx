// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Modal } from '../src/renderer/src/components/Modal'

afterEach(cleanup)

describe('Modal', () => {
  it('declare une boite de dialogue avec le titre et le contenu', () => {
    const { container } = render(
      <Modal title="Tout supprimer" onClose={vi.fn()}>
        <p>Le corps du modal</p>
      </Modal>
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Tout supprimer')
    expect(screen.getByText('Le corps du modal')).toBeTruthy()
    expect(container.querySelector('.modal-backdrop')).not.toBeNull()
  })

  it('place le focus sur la croix à l’ouverture', () => {
    render(
      <Modal title="Focus" onClose={vi.fn()}>
        corps
      </Modal>
    )

    expect(document.activeElement).toBe(screen.getByLabelText('Fermer'))
  })

  it('referme sur Échap', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Échap" onClose={onClose}>
        corps
      </Modal>
    )

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('referme au clic sur le fond, mais pas sur le contenu', () => {
    const onClose = vi.fn()
    const { container } = render(
      <Modal title="Fond" onClose={onClose}>
        corps
      </Modal>
    )

    fireEvent.click(screen.getByText('corps'))
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    const backdrop = container.querySelector('.modal-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('referme au clic sur la croix', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Croix" onClose={onClose}>
        corps
      </Modal>
    )

    fireEvent.click(screen.getByLabelText('Fermer'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ne referme que la modale du dessus quand elles sont superposées', () => {
    const onParentClose = vi.fn()
    const onChildClose = vi.fn()
    render(
      <Modal title="Parent" onClose={onParentClose}>
        <Modal title="Enfant" onClose={onChildClose}>
          corps
        </Modal>
      </Modal>
    )

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onChildClose).toHaveBeenCalledTimes(1)
    expect(onParentClose).not.toHaveBeenCalled()
  })

  it('referme la modale parente après la fermeture de l’enfant', () => {
    const onParentClose = vi.fn()
    const onChildClose = vi.fn()
    const { rerender } = render(
      <Modal title="Parent" onClose={onParentClose}>
        <Modal title="Enfant" onClose={onChildClose}>
          corps
        </Modal>
      </Modal>
    )

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onChildClose).toHaveBeenCalledTimes(1)
    expect(onParentClose).not.toHaveBeenCalled()

    rerender(
      <Modal title="Parent" onClose={onParentClose}>
        corps
      </Modal>
    )
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onParentClose).toHaveBeenCalledTimes(1)
  })

  it('retire son écouteur de clavier au démontage', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <Modal title="Fuite" onClose={onClose}>
        corps
      </Modal>
    )

    unmount()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onClose).not.toHaveBeenCalled()
  })
})
