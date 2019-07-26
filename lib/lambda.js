const ESUpdateJob = require('./es/es-update-job')

function es (event) {
  const connectionClass = require('http-aws-es')
  const makeClient = require('./es/make-client')

  const client = makeClient(connectionClass)
  const job = new ESUpdateJob(client)
  return job.run(event)
}

module.exports = {
  es
}