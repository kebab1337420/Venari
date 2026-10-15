import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * L'identite applicative vit dans deux fichiers qui doivent rester d'accord :
 * - `electron-builder.yml` (`appId`) : AUMID inscrit dans les raccourcis NSIS ;
 * - `src/main/index.ts` (`APP_ID`) : `setAppUserModelId` au runtime.
 * Un desaccord desynchronise l'association barre des taches / notifications
 * Windows. Le `guid` NSIS, lui, doit rester fige : il porte la detection de
 * version precedente et les cles de registre des installations deja en place.
 */

function readRepoFile(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
}

describe('identite applicative', () => {
  it("l'appId d'empaquetage et l'APP_ID runtime restent alignes", () => {
    const yml = readRepoFile('electron-builder.yml')
    const source = readRepoFile('src/main/index.ts')
    const packaged = /^appId:\s*(\S+)\s*$/m.exec(yml)?.[1]
    const runtime = /const APP_ID = '([^']+)'/.exec(source)?.[1]
    expect(packaged).toBe('com.venari.app')
    expect(runtime).toBe(packaged)
  })

  it('le guid NSIS reste fige a la valeur heritee', () => {
    const yml = readRepoFile('electron-builder.yml')
    const guid = /^guid:\s*(\S+)\s*$/m.exec(yml)?.[1]
    // UUID.v5('com.bountydesk.app', 50e065bc-3134-11e6-9bab-38c9862bdaf3) :
    // le figer evite d'orpheliner les installations existantes.
    expect(guid).toBe('0044a2be-1027-53ff-a499-b09e857f6ea5')
  })
})
