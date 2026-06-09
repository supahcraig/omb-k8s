"""Driver library CRUD router — /api/drivers."""
import logging
from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Driver
from schemas import DriverCreate, DriverOut, DriverUpdate

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("")
async def list_drivers(db: AsyncSession = Depends(get_db)) -> dict:
    result = await db.execute(select(Driver).order_by(Driver.created_at))
    drivers = result.scalars().all()
    return {
        "bundled": [DriverOut.model_validate(d) for d in drivers if d.is_bundled],
        "custom":  [DriverOut.model_validate(d) for d in drivers if not d.is_bundled],
    }


@router.post("", response_model=DriverOut, status_code=201)
async def create_driver(body: DriverCreate, db: AsyncSession = Depends(get_db)) -> DriverOut:
    if body.cloned_from_id is not None:
        result = await db.execute(select(Driver).where(Driver.id == body.cloned_from_id))
        if result.scalar_one_or_none() is None:
            raise HTTPException(status_code=404, detail=f"Source driver '{body.cloned_from_id}' not found.")
    driver = Driver(
        id=str(uuid4()),
        name=body.name,
        description=body.description,
        content=body.content,
        is_bundled=False,
        cloned_from_id=body.cloned_from_id,
    )
    db.add(driver)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return DriverOut.model_validate(driver)


@router.put("/{driver_id}", response_model=DriverOut)
async def update_driver(driver_id: str, body: DriverUpdate, db: AsyncSession = Depends(get_db)) -> DriverOut:
    result = await db.execute(select(Driver).where(Driver.id == driver_id))
    driver = result.scalar_one_or_none()
    if driver is None:
        raise HTTPException(status_code=404, detail="Driver not found.")
    if driver.is_bundled:
        raise HTTPException(status_code=403, detail="Bundled drivers are read-only.")
    driver.name = body.name
    driver.content = body.content
    driver.description = body.description
    driver.updated_at = datetime.utcnow()
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return DriverOut.model_validate(driver)


@router.delete("/{driver_id}", status_code=204)
async def delete_driver(driver_id: str, db: AsyncSession = Depends(get_db)) -> None:
    result = await db.execute(select(Driver).where(Driver.id == driver_id))
    driver = result.scalar_one_or_none()
    if driver is None:
        raise HTTPException(status_code=404, detail="Driver not found.")
    if driver.is_bundled:
        raise HTTPException(status_code=403, detail="Bundled drivers are read-only.")
    await db.delete(driver)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise
