from services.kb.src.search import search_knowledge_base


def test_search_docs():
    results = search_knowledge_base("docs", "source mode")
    assert results
    assert any("source" in result.excerpt.lower() for result in results)
