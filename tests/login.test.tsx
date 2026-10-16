// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthValidateResult } from '../src/shared/ipc'
import { Api } from '../src/renderer/src/api'
import { LoginScreen } from '../src/renderer/src/screens/Login'

// Le pont preload n'existe pas dans jsdom : on ne teste que la logique React,
// l'IPC reel est couvert par les tests de src/main.
vi.mock('../src/renderer/src/api', () => ({
  Api: { auth: { validate: vi.fn() } }
}))

afterEach(cleanup)

const validate = vi.mocked(Api.auth.validate)

function submitOf(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form')
  expect(form).not.toBeNull()
  return form as HTMLFormElement
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button') as HTMLButtonElement
}

describe('LoginScreen', () => {
  it('garde le bouton inactif tant que le jeton fait moins de 10 caracteres', () => {
    const onLoggedIn = vi.fn()
    const { container } = render(<LoginScreen onLoggedIn={onLoggedIn} />)

    const input = screen.getByPlaceholderText('Jeton API Intigriti')
    fireEvent.change(input, { target: { value: '123456789' } })

    expect(submitButton().disabled).toBe(true)
    fireEvent.submit(submitOf(container))
    expect(validate).not.toHaveBeenCalled()
    expect(onLoggedIn).not.toHaveBeenCalled()
  })

  it('active le bouton des que le jeton atteint 10 caracteres', () => {
    render(<LoginScreen onLoggedIn={vi.fn()} />)

    const input = screen.getByPlaceholderText('Jeton API Intigriti')
    fireEvent.change(input, { target: { value: '1234567890' } })

    expect(submitButton().disabled).toBe(false)
  })

  it('valide le jeton despace et connecte si le main repond ok', async () => {
    validate.mockResolvedValue({ ok: true })
    const onLoggedIn = vi.fn()
    const { container } = render(<LoginScreen onLoggedIn={onLoggedIn} />)

    const input = screen.getByPlaceholderText('Jeton API Intigriti')
    fireEvent.change(input, { target: { value: '  abcdefghijkl  ' } })
    fireEvent.submit(submitOf(container))

    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1))
    expect(validate).toHaveBeenCalledWith('abcdefghijkl')
  })

  it("affiche l'erreur renvoyee par le main sans connecter", async () => {
    validate.mockResolvedValue({ ok: false, error: 'Jeton invalide' })
    const onLoggedIn = vi.fn()
    const { container } = render(<LoginScreen onLoggedIn={onLoggedIn} />)

    const input = screen.getByPlaceholderText('Jeton API Intigriti')
    fireEvent.change(input, { target: { value: '1234567890' } })
    fireEvent.submit(submitOf(container))

    expect(await screen.findByText('Jeton invalide')).toBeTruthy()
    expect(onLoggedIn).not.toHaveBeenCalled()
    expect(submitButton().disabled).toBe(false)
  })

  it('occupe le bouton pendant la validation', async () => {
    let settle!: (result: AuthValidateResult) => void
    validate.mockReturnValue(new Promise<AuthValidateResult>((resolve) => {
      settle = resolve
    }))

    const onLoggedIn = vi.fn()
    const { container } = render(<LoginScreen onLoggedIn={onLoggedIn} />)

    const input = screen.getByPlaceholderText('Jeton API Intigriti')
    fireEvent.change(input, { target: { value: '1234567890' } })
    fireEvent.submit(submitOf(container))

    expect(submitButton().disabled).toBe(true)
    expect(submitButton().textContent).toContain('Vérification')

    await act(async () => {
      settle({ ok: true })
    })

    expect(onLoggedIn).toHaveBeenCalledTimes(1)
    expect(submitButton().disabled).toBe(false)
  })
})
