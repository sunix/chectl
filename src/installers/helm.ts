/*********************************************************************
 * Copyright (c) 2019 Red Hat, Inc.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 **********************************************************************/
// tslint:disable:object-curly-spacing

import { Command } from '@oclif/command'
import * as commandExists from 'command-exists'
import * as execa from 'execa'
import * as fs from 'fs'
import { mkdirp } from 'fs-extra'
import * as Listr from 'listr'
import { ncp } from 'ncp'
import * as path from 'path'

import { KubeHelper } from '../api/kube'

export class HelmHelper {
  startTasks(flags: any, command: Command): Listr {
    return new Listr([
      {
        title: 'Verify if helm is installed',
        task: () => { if (!commandExists.sync('helm')) { command.error('E_REQUISITE_NOT_FOUND') } }
      },
      {
        title: 'Check for TLS prerequisites',
        // Check only if TLS is enabled
        enabled: () => {
          return flags.tls
        },
        task: async (_ctx: any, task: any) => {
          const kh = new KubeHelper()
          const exists = await kh.secretExist('che-tls')
          if (!exists) {
            throw new Error('TLS option is enabled but che-tls secret does not exist in default namespace. Example on how to create the secret: kubectl create secret generic che-tls --from-literal=ACME_EMAIL=my@email-address.com')
          }
          task.title = `${task.title} che-tls secret exist.`
        }
      },
      {
        title: 'Create Tiller Role Binding',
        task: async (_ctx: any, task: any) => {
          const roleBindingExist = await this.tillerRoleBindingExist()
          if (roleBindingExist) {
            task.title = `${task.title}...it already exist.`
          } else {
            await this.createTillerRoleBinding()
            task.title = `${task.title}...done.`
          }
        }
      },
      {
        title: 'Create Tiller Service Account',
        task: async (_ctx: any, task: any) => {
          const tillerServiceAccountExist = await this.tillerServiceAccountExist()
          if (tillerServiceAccountExist) {
            task.title = `${task.title}...it already exist.`
          } else {
            await this.createTillerServiceAccount()
            task.title = `${task.title}...done.`
          }
        }
      },
      {
        title: 'Create Tiller RBAC',
        task: async () => this.createTillerRBAC(flags.templates)
      },
      {
        title: 'Create Tiller Service',
        task: async (_ctx: any, task: any) => {
          const tillerServiceExist = await this.tillerServiceExist()
          if (tillerServiceExist) {
            task.title = `${task.title}...it already exist.`
          } else {
            await this.createTillerService()
            task.title = `${task.title}...done.`
          }
        }
      },
      {
        title: 'Preparing Che Helm Chart',
        task: async (_ctx: any, task: any) => {
          await this.prepareCheHelmChart(flags, command.config.cacheDir)
          task.title = `${task.title}...done.`
        }
      },
      {
        title: 'Updating Helm Chart dependencies',
        task: async (_ctx: any, task: any) => {
          await this.updateCheHelmChartDependencies(command.config.cacheDir)
          task.title = `${task.title}...done.`
        }
      },
      {
        title: 'Deploying Che Helm Chart',
        task: async (_ctx: any, task: any) => {
          await this.upgradeCheHelmChart(flags, command.config.cacheDir)
          task.title = `${task.title}...done.`
        }
      },
    ], {renderer: flags['listr-renderer'] as any})
  }

  async tillerRoleBindingExist(execTimeout= 30000): Promise<boolean> {
    const { code } = await execa('kubectl', ['get', 'clusterrolebinding', 'add-on-cluster-admin'], { timeout: execTimeout, reject: false })
    if (code === 0) { return true } else { return false }
  }

  async createTillerRoleBinding(execTimeout= 30000) {
    await execa('kubectl', ['create', 'clusterrolebinding', 'add-on-cluster-admin', '--clusterrole=cluster-admin', '--serviceaccount=kube-system:default'], { timeout: execTimeout})
  }

  async tillerServiceAccountExist(execTimeout= 30000): Promise<boolean> {
    const { code } = await execa('kubectl', ['get', 'serviceaccounts', 'tiller', '--namespace', 'kube-system'], { timeout: execTimeout, reject: false })
    if (code === 0) { return true } else { return false }
  }

  async createTillerServiceAccount(execTimeout= 120000) {
    await execa('kubectl', ['create', 'serviceaccount', 'tiller', '--namespace', 'kube-system'], { timeout: execTimeout})
  }

  async createTillerRBAC(templatesPath: any, execTimeout= 30000) {
    const yamlPath = path.join(templatesPath, '/kubernetes/helm/che/tiller-rbac.yaml')
    const yamlContent = fs.readFileSync(yamlPath, 'utf8')
    const command = `echo "${yamlContent}" | kubectl apply -f -`
    await execa.shell(command, { timeout: execTimeout })
  }

  async tillerServiceExist(execTimeout= 30000): Promise<boolean> {
    const { code } = await execa('kubectl', ['get', 'services', 'tiller-deploy', '-n', 'kube-system'], { timeout: execTimeout, reject: false})
    if (code === 0) { return true } else { return false }
  }

  async createTillerService(execTimeout= 120000) {
    const { cmd, code, stderr, stdout, timedOut } =
                  await execa('helm', ['init', '--service-account', 'tiller', '--wait'], { timeout: execTimeout, reject: false })
    if (timedOut) {
      throw new Error(`Command "${cmd}" timed out after ${execTimeout}ms
stderr: ${stderr}
stdout: ${stdout}
error: E_TIMEOUT`)
    }
    if (code !== 0) {
      throw new Error(`Command "${cmd}" failed with return code ${code}
stderr: ${stderr}
stdout: ${stdout}
error: E_COMMAND_FAILED`)
    }
  }

  async prepareCheHelmChart(flags: any, cacheDir: string) {
    const srcDir = path.join(flags.templates, '/kubernetes/helm/che/')
    const destDir = path.join(cacheDir, '/templates/kubernetes/helm/che/')
    await mkdirp(destDir)
    await ncp(srcDir, destDir, {}, (err: Error) => { if (err) { throw err } })
  }

  async updateCheHelmChartDependencies(cacheDir: string, execTimeout= 120000) {
    const destDir = path.join(cacheDir, '/templates/kubernetes/helm/che/')
    await execa.shell(`helm dependencies update --skip-refresh ${destDir}`, { timeout: execTimeout })
  }

  async upgradeCheHelmChart(flags: any, cacheDir: string, execTimeout= 120000) {
    const destDir = path.join(cacheDir, '/templates/kubernetes/helm/che/')

    let multiUserFlag = ''
    let tlsFlag = ''
    let setOptions = ''

    if (flags.multiuser) {
      multiUserFlag = `-f ${destDir}values/multi-user.yaml`
    }

    if (flags.tls) {
      setOptions = `--set global.cheDomain=${flags.domain}`
      tlsFlag = `-f ${destDir}values/tls.yaml`
    }

    let command = `helm upgrade --install che --force --namespace ${flags.chenamespace} --set global.ingressDomain=${flags.domain} ${setOptions} --set cheImage=${flags.cheimage} --set global.cheWorkspacesNamespace=${flags.chenamespace} ${multiUserFlag} ${tlsFlag} ${destDir}`

    let {code, stderr} = await execa.shell(command, { timeout: execTimeout, reject: false })
    // if process failed, check the following
    // if revision=1, purge and retry command else rollback
    if (code !== 0) {
      // get revision

      const {code, stdout} = await execa.shell(`helm history ${flags.chenamespace} --output json`, { timeout: execTimeout, reject: false })
      if (code !== 0) {
        throw new Error(`Unable to execute helm command ${command} / ${stderr}`)
      }
      let jsonOutput
      try {
        jsonOutput = JSON.parse(stdout)
      } catch (err) {
        throw new Error('Unable to grab helm history:' + err)
      }
      const revision = jsonOutput[0].revision
      if (jsonOutput.length > 0 && revision === '1') {
        await this.purgeHelmChart(flags.chenamespace)
      } else {
        await execa('helm', ['rollback', flags.chenamespace, revision], { timeout: execTimeout })

      }
      await execa.shell(command, { timeout: execTimeout })

    }
  }

  async purgeHelmChart(name: string, execTimeout= 30000) {
    await execa('helm', ['delete', name, '--purge'], { timeout: execTimeout, reject: false})
  }

}
