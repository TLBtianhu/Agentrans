#!/usr/bin/env node

import { Context } from '@agentrans/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@agentrans/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@agentrans/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
