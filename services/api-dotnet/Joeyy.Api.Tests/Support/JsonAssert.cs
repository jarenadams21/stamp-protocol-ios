using System.Text.Json;
using System.Text.Json.Nodes;

namespace Joeyy.Api.Tests.Support;

public static class JsonAssert
{
    /// <summary>Deep equality of JSON values, ignoring property order (like assert.deepEqual on parsed JSON).</summary>
    public static void Equal(object expected, JsonElement actual)
    {
        var expectedNode = JsonSerializer.SerializeToNode(expected, Infrastructure.Json.Options);
        var actualNode = JsonNode.Parse(actual.GetRawText());
        Assert.True(JsonNode.DeepEquals(expectedNode, actualNode), $"Expected {expectedNode?.ToJsonString()} but got {actualNode?.ToJsonString()}");
    }

    public static string[] Keys(JsonElement value) => value.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();
}
