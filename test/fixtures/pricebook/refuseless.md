> ## Documentation Index
> Fetch the complete documentation index at: https://docs.refuseless.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Models API

> GET /v1/models and GET /v1/models/{model}.

# Models API

## List models

```
GET https://api.refuseless.com/v1/models
```

The list is public. Without a key it returns the public lineup. With a key it
also includes any private models granted to that key's account.

```json theme={null}
{
  "object": "list",
  "data": [
    { "id": "glm-5.3-abliterated", "object": "model", "created": 1700000000, "owned_by": "refuseless", "abliterated": true, "context_length": 1048576, "reasoning_efforts": ["low", "high", "max"], "reasoning_default": "low" },
    { "id": "glm-5.3-flash-abliterated", "object": "model", "created": 1700000000, "owned_by": "refuseless", "abliterated": true, "context_length": 1048576, "reasoning_efforts": ["low", "high", "max"], "reasoning_default": "low" },
    { "id": "deepseek-v4.1-flash-abliterated", "object": "model", "created": 1700000000, "owned_by": "refuseless", "abliterated": true, "context_length": 1048576, "reasoning_efforts": ["off", "low", "high", "max"], "reasoning_default": "low" },
    { "id": "deepseek-v4.1-flash-fast", "object": "model", "created": 1700000000, "owned_by": "refuseless", "abliterated": false, "context_length": 1048576, "reasoning_efforts": ["off", "low", "high", "max"], "reasoning_default": "low" },
    { "id": "minimax-m3.1-flash", "object": "model", "created": 1700000000, "owned_by": "refuseless", "abliterated": false, "context_length": 1048576, "reasoning_efforts": ["low", "high", "max"], "reasoning_default": "low" },
    { "id": "deepseek-v4.1-flash-abliterated-free", "object": "model", "created": 1700000000, "owned_by": "refuseless", "abliterated": true, "context_length": 524288, "reasoning_efforts": ["off", "low", "high", "max"], "reasoning_default": "low" }
  ]
}
```

### Fields

| Field | Type | Notes |
| - | - | - |
| `id` | string | The id to send as `model`. |
| `object` | string | Always `"model"`. |
| `created` | integer | Unix timestamp. |
| `owned_by` | string | Always `"refuseless"`. |
| `abliterated` | boolean | Always present. See below. |
| `vision` | boolean | `true` when the model accepts image input. Sending an image to a model with `false` returns `400`. Omitted only by the local fallback list. |
| `context_length` | integer | Context window in tokens. Omitted when the catalog has no value. |
| `reasoning_efforts` | string\[] | Reasoning levels the model accepts, from `off`, `low`, `high`, `max`. Omitted when none are set. |
| `reasoning_default` | string | The level used when the request does not set one. Omitted when none is set. |

`context_length` uses the same field name as OpenRouter.

`abliterated` is `true` when refusal behavior has been removed from the
weights and `false` for standard weights (for example,
`deepseek-v4.1-flash-fast` and `minimax-m3.1-flash`). Filter on this field
rather than on the `-abliterated` suffix: ids are catalog names and may not
follow that pattern.

Sending a reasoning level that is not in the model's `reasoning_efforts`
returns `400`. See [Reasoning](https://docs.refuseless.com/guides/reasoning.md).

A live empty catalog is the catalog. The local fallback only applies when
the billing service is unreachable.

## Retrieve a model

```
GET https://api.refuseless.com/v1/models/{model}
```

```json theme={null}
{
  "id": "deepseek-v4.1-flash-abliterated",
  "object": "model",
  "created": 1700000000,
  "owned_by": "refuseless",
  "abliterated": true,
  "context_length": 1048576,
  "reasoning_efforts": ["off", "low", "high", "max"],
  "reasoning_default": "low"
}
```

Unknown id → `404`:

```json theme={null}
{
  "error": { "code": "model_not_found", "message": "Unknown model '…'.", "type": "api_error" }
}
```


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.