from pathlib import Path

from rdflib import Graph, Namespace, OWL, RDF


def test_orca_ontology_is_valid_and_contains_complete_model():
    path = Path(__file__).parents[1] / "ontology" / "orca-graph.ttl"
    graph = Graph().parse(path, format="turtle")
    orca = Namespace("https://orca-graph.example/ontology/")

    for term in [
        orca.Scope,
        orca.KPI,
        orca.Agent,
        orca.PrincipalAgent,
        orca.AuxiliaryAgent,
        orca.SupportAgent,
        orca.ResearchSupportAgent,
        orca.TrainingSupportAgent,
        orca.GovernmentSupportAgent,
        orca.NationalGovernmentSupportAgent,
        orca.RegionalGovernmentSupportAgent,
        orca.ValueChain,
        orca.ValueChainLink,
        orca.ApplicationLevel,
    ]:
        assert (term, RDF.type, OWL.Class) in graph

    for term in [
        orca.hasSubscope,
        orca.hasSuperscope,
        orca.similarTo,
        orca.hasValueChainLink,
        orca.belongsTo,
        orca.participatesInValueChainLink,
        orca.appliesToValueChainLink,
        orca.appliesToAgent,
        orca.appliesToScope,
        orca.hasKPI,
        orca.precedes,
        orca.unitOfMeasure,
    ]:
        assert (term, RDF.type, OWL.ObjectProperty) in graph

    assert (orca.similarTo, RDF.type, OWL.SymmetricProperty) in graph
