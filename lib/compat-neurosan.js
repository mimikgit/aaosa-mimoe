// neuro-san external-agent compatibility shim.
//
// A genuine neuro-san network can list an external agent as a tool by URL
// (http://host:port/agent_name). Under the hood it talks to that server's
// HTTP surface. This shim serves a working approximation of the two routes
// that matter, backed by the native AAOSA pipeline:
//
//   GET  /api/v1/<name>/function        -> callable signature
//   POST /api/v1/<name>/streaming_chat  -> run pipeline, stream result
//
// IMPORTANT: before claiming wire compatibility, align these bodies to the
// neuro-san OpenAPI spec (neuro-san docs/clients.md and their protos),
// including chat_context echo semantics. This file is the seam to do it in.

'use strict';

function compatRoutes(agent) {
  return {
    // GET /api/v1/<name>/function
    functionSpec() {
      return {
        function: {
          description: agent.description,
          parameters: {
            type: 'object',
            properties: { inquiry: { type: 'string', description: 'The inquiry' } },
            required: ['inquiry'],
          },
        },
      };
    },

    // POST /api/v1/<name>/streaming_chat
    // Streams newline-delimited JSON chunks, final chunk carries the answer.
    async streamingChat(reqBody, res) {
      const text =
        reqBody?.user_message?.text ??
        reqBody?.inquiry ??
        reqBody?.message ??
        '';
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });

      // Determine whether this agent handles the inquiry itself or via peers,
      // then answer through the native pipeline.
      const up = await agent.orchestrate(text);
      const own = await agent.handleAaosa({
        v: '0.1',
        id: require('node:crypto').randomUUID(),
        corr: up.corr,
        mode: 'fulfil',
        inquiry: text,
        context: {},
        hops: 0,
        ttl: 1, // own contribution only; peer work already done by orchestrate
        visited: [],
        deadlineMs: 20000,
      });

      const answer = [up.answer, own.status === 'ok' ? own.answer : '']
        .filter(Boolean)
        .join('\n\n');

      const chunk = {
        response: { type: 'AI', text: answer },
        // Echo a minimal chat_context so callers that thread state keep working.
        chat_context: reqBody?.chat_context ?? {},
      };
      res.end(JSON.stringify(chunk) + '\n');
    },
  };
}

module.exports = { compatRoutes };
