from pathlib import Path

import pytest
from rdflib import Graph, Literal, Namespace, OWL, RDF, RDFS, URIRef, XSD

from app.graphdb import graphdb


def test_orca_ontology_is_valid_and_contains_complete_model():
    path = Path(__file__).parents[1] / "ontology" / "orca-graph.ttl"
    graph = Graph().parse(path, format="turtle")
    orca = Namespace("https://orca-graph.example/ontology/")

    for term in [
        orca.Scope,
        orca.Component,
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
        orca.LocalGovernmentSupportAgent,
        orca.ValueChain,
        orca.ValueChainLink,
    ]:
        assert (term, RDF.type, OWL.Class) in graph
        assert (term, orca.coreConcept, Literal(True, datatype=XSD.boolean)) in graph

    for term in [
        orca.hasComponent,
        orca.isComponentOf,
        orca.hasSubcomponent,
        orca.hasSupercomponent,
        orca.similarTo,
        orca.hasValueChainLink,
        orca.belongsTo,
        orca.participatesInValueChainLink,
        orca.appliesToAgent,
        orca.appliesToComponent,
        orca.hasKPI,
        orca.hasAssociatedKPI,
        orca.isRelated,
        orca.muevePescadoFresco,
        orca.muevePescadoSeco,
        orca.mueveHarinaDePescado,
        orca["financiación"],
        orca.inValueChain,
    ]:
        assert (term, RDF.type, OWL.ObjectProperty) in graph

    assert (orca.unitOfMeasure, None, None) not in graph
    assert (orca.definition, None, None) not in graph
    for term in [orca.name, orca.identification, orca.description, orca.evaluation]:
        assert (term, RDF.type, OWL.DatatypeProperty) in graph
        assert (term, RDFS.range, XSD.string) in graph
    assert (orca.inValueChain, RDFS.range, orca.ValueChain) in graph

    assert (orca.similarTo, RDF.type, OWL.SymmetricProperty) in graph
    for term in [orca.muevePescadoFresco, orca.muevePescadoSeco, orca.mueveHarinaDePescado, orca["financiación"]]:
        assert (term, RDFS.subPropertyOf, orca.isRelated) in graph


@pytest.mark.asyncio
async def test_only_later_concepts_are_deletable(monkeypatch):
    orca = Namespace("https://orca-graph.example/ontology/")
    ontology = Graph()
    ontology.add((orca.KPI, RDF.type, OWL.Class))
    ontology.add((orca.KPI, RDFS.label, Literal("KPI", lang="es")))
    ontology.add((orca.KPI, orca.coreConcept, Literal(True, datatype=XSD.boolean)))
    later = URIRef(f"{orca}ConceptoPosterior")
    ontology.add((later, RDF.type, OWL.Class))
    ontology.add((later, RDFS.label, Literal("Concepto posterior", lang="es")))
    monkeypatch.setattr(graphdb, "_read_ontology", lambda: ontology)

    concepts = {concept.iri: concept for concept in await graphdb.concepts(include_hidden=True)}
    assert concepts[str(orca.KPI)].deletable is False
    assert concepts[str(later)].deletable is True
